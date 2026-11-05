// Claude Code 的清单(.claude-plugin/plugin.json):不认识的键忽略,类型不对的键当没写
import { isObject, PROTO_NAMES } from './types'
import { USER_CONFIG_KEY_RE, type CommandDecl, type Manifest, type McpDecl, type UserConfigDecl } from './manifest'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** 文件内容或内联:顶层 `mcpServers`,或直接按名字。返回 Map,名字不碰原型 */
export function unwrapServers(v: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (!isObject(v)) return out
  const inner = Object.getOwnPropertyDescriptor(v, 'mcpServers')?.value
  const src = isObject(inner) && Object.values(inner).every(isObject) ? inner : v
  for (const [k, raw] of Object.entries(src)) out.set(k, raw)
  return out
}

function commandsOf(v: unknown): CommandDecl | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'string' || Array.isArray(v)) return { paths: strings(v), map: new Map() }
  if (!isObject(v)) return undefined
  const map = new Map<string, { source?: string; content?: string }>()
  for (const [name, e] of Object.entries(v)) if (isObject(e)) map.set(name, { source: str(e.source), content: str(e.content) })
  return { paths: [], map }
}

function mcpOf(v: unknown): McpDecl[] {
  if (typeof v === 'string') return [{ kind: 'path', path: v }]
  if (Array.isArray(v)) return v.flatMap(mcpOf)
  if (isObject(v)) return [{ kind: 'inline', servers: unwrapServers(v) }]
  return []
}

function userConfigOf(v: unknown): Map<string, UserConfigDecl> {
  const out = new Map<string, UserConfigDecl>()
  if (!isObject(v)) return out
  for (const [key, raw] of Object.entries(v)) {
    if (!USER_CONFIG_KEY_RE.test(key) || PROTO_NAMES.has(key) || !isObject(raw)) continue
    out.set(key, {
      title: str(raw.title),
      description: str(raw.description),
      sensitive: raw.sensitive === true,
      required: raw.required === true,
      type: str(raw.type) ?? 'string',
    })
  }
  return out
}

const OTHER_KEYS = ['agents', 'monitors', 'workflows', 'lspServers', 'outputStyles', 'themes', 'settings', 'dependencies', 'channels', 'bin']

export function parseClaudeManifest(json: unknown): { ok: true; manifest: Manifest } | { ok: false } {
  if (!isObject(json)) return { ok: false }
  const author = isObject(json.author) ? str(json.author.name) : str(json.author)
  const other = new Map<string, unknown>()
  for (const k of OTHER_KEYS) if (Object.hasOwn(json, k)) other.set(k, json[k])
  return {
    ok: true,
    manifest: {
      name: str(json.name),
      version: str(json.version),
      description: str(json.description),
      author,
      homepage: str(json.homepage),
      skills: strings(json.skills),
      commands: commandsOf(json.commands),
      mcp: mcpOf(json.mcpServers),
      userConfig: userConfigOf(json.userConfig),
      hooks: Object.hasOwn(json, 'hooks') ? [json.hooks] : [],
      other,
      main: str(json.main),
    },
  }
}

/** 由 name 得出 id:小写,非法字符换 `-`,首尾去 `-`。空就是 null */
export function deriveId(name: string): string | null {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : null
}
