// 原生清单 mff-plugin.json(09 spec §5.1):zod strict,写错要说出来。权限只能收窄,写不出路径
import { z } from 'zod'
import { sanitizeLine } from '../memory/wrap'
import { clip, isObject, PROTO_NAMES, type ConfigKey, type Cwd } from './types'

/** 只收 精确、^、~;别的写法一律不满足 */
export function satisfiesKernel(range: string, version: string): boolean {
  const r = /^([\^~]?)(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(range)
  const v = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(version)
  if (!r || !v) return false
  const want = [Number(r[2]), Number(r[3]), Number(r[4])]
  const have = [Number(v[1]), Number(v[2]), Number(v[3])]
  const cmp = () => {
    for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] - want[i]
    return 0
  }
  if (r[1] === '') return cmp() === 0
  if (cmp() < 0) return false
  if (r[1] === '~') return have[0] === want[0] && have[1] === want[1]
  if (want[0] > 0) return have[0] === want[0]
  if (want[1] > 0) return have[0] === 0 && have[1] === want[1]
  return have[0] === 0 && have[1] === 0 && have[2] === want[2]
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
const INTERNAL_SUFFIX = /\.(?:local|localhost|internal|lan|home|intranet|corp|private|arpa)$/

/** 域名:拒 `*`、路径、端口、裸 IP、内网名 */
export function validHost(h: string): boolean {
  return HOST_RE.test(h) && !INTERNAL_SUFFIX.test(h) && !/^[0-9.]+$/.test(h)
}

const Hosts = z.array(z.string().refine(validHost, 'network entries must be public host names')).max(50)

const NativeServerSchema = z
  .object({
    command: z.string().min(1).max(1024),
    args: z.array(z.string().max(4096)).max(256).optional(),
    env: z.record(z.string(), z.string().max(65536)).optional(),
    permissions: z.object({ network: Hosts.optional(), cwd: z.enum(['none', 'read', 'write']).optional() }).strict().optional(),
  })
  .strict()

const UserConfigSchema = z
  .object({
    title: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
    sensitive: z.boolean().optional(),
    required: z.boolean().optional(),
    type: z.enum(['string', 'number', 'boolean']).optional(),
  })
  .strict()

const Paths = z.union([z.string().max(1024), z.array(z.string().max(1024)).max(50)])

// mcpServers 和 userConfig 用 unknown 收下,逐项另验:zod 的 record 会把键写进普通对象,`__proto__` 当键时会丢
const NativeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    version: z.string().regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,32})?$/),
    kernel: z.string().max(64).optional(),
    name: z.string().max(200).optional(),
    description: z.string().max(5000).optional(),
    author: z.string().max(200).optional(),
    homepage: z.string().max(500).optional(),
    skills: Paths.optional(),
    commands: Paths.optional(),
    mcpServers: z.unknown().optional(),
    userConfig: z.unknown().optional(),
    main: z.string().max(1024).optional(),
  })
  .strict()

export interface UserConfigDecl {
  title?: string
  description?: string
  sensitive: boolean
  required: boolean
  type: string
}

export type CommandDecl = { paths: string[]; map: Map<string, { source?: string; content?: string }> }
export type McpDecl = { kind: 'path'; path: string } | { kind: 'inline'; servers: Map<string, unknown> }

/** 两种格式读完后的同一个形状 */
export interface Manifest {
  name?: string
  version?: string
  description?: string
  author?: string
  homepage?: string
  kernel?: string
  /** 追加到默认的 skills/ */
  skills: string[]
  /** 有这个键就替换默认的 commands/ */
  commands?: CommandDecl
  mcp: McpDecl[]
  userConfig: Map<string, UserConfigDecl>
  hooks: unknown[]
  /** agents、monitors、workflows、lspServers、outputStyles、themes、settings、dependencies、channels、bin 的原值 */
  other: Map<string, unknown>
  main?: string
  /** 列表超过上限被截了 */
  truncated?: boolean
}

export type NativeManifest = Manifest & { id: string; version: string }

export const USER_CONFIG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

const asList = (v: string | string[] | undefined) => (v === undefined ? [] : typeof v === 'string' ? [v] : v)

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error: clip(sanitizeLine(error), 200) }
}

export function parseNative(json: unknown): { ok: true; manifest: NativeManifest } | { ok: false; error: string } {
  try {
    if (!isObject(json)) return fail('manifest must be an object')
    const top = NativeSchema.safeParse(json)
    if (!top.success) {
      const i = top.error.issues[0]
      return fail(`${i.path.join('.') || 'manifest'}: ${i.message}`)
    }
    const m = top.data

    const servers = new Map<string, unknown>()
    if (m.mcpServers !== undefined) {
      if (!isObject(m.mcpServers)) return fail('mcpServers: must be an object')
      for (const [name, raw] of Object.entries(m.mcpServers)) {
        const r = NativeServerSchema.safeParse(raw)
        if (!r.success) {
          const i = r.error.issues[0]
          return fail(`mcpServers.${name}.${i.path.join('.')}: ${i.message}`)
        }
        servers.set(name, raw)
      }
    }

    const userConfig = new Map<string, UserConfigDecl>()
    if (m.userConfig !== undefined) {
      if (!isObject(m.userConfig)) return fail('userConfig: must be an object')
      for (const [key, raw] of Object.entries(m.userConfig)) {
        if (!USER_CONFIG_KEY_RE.test(key) || PROTO_NAMES.has(key)) return fail(`userConfig.${key}: bad key`)
        const r = UserConfigSchema.safeParse(raw)
        if (!r.success) return fail(`userConfig.${key}.${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`)
        userConfig.set(key, { title: r.data.title, description: r.data.description, sensitive: r.data.sensitive ?? false, required: r.data.required ?? false, type: r.data.type ?? 'string' })
      }
    }

    const commands = m.commands === undefined ? undefined : { paths: asList(m.commands), map: new Map() }
    return {
      ok: true,
      manifest: {
        id: m.id,
        version: m.version,
        kernel: m.kernel,
        name: m.name,
        description: m.description,
        author: m.author,
        homepage: m.homepage,
        skills: asList(m.skills),
        commands,
        mcp: servers.size > 0 ? [{ kind: 'inline', servers }] : [],
        userConfig,
        hooks: [],
        other: new Map(),
        main: m.main,
      },
    }
  } catch {
    return fail('manifest could not be read')
  }
}

export function configKeysOf(decls: Map<string, UserConfigDecl>): ConfigKey[] {
  return [...decls.entries()]
    .map(([key, d]) => ({ key, title: d.title ?? d.description ?? key, sensitive: d.sensitive, required: d.required, type: d.type, from: 'manifest' as const }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export type { Cwd }
