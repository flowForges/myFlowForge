// 服务配置检查(09 spec §8.2 修订后):只读数据,有 problems 就不启动。
// 环境变量里的 `${VAR}` 不从宿主取:列出来等用户填(source:'secret')
import { isObject, PROTO_NAMES, SERVER_NAME_RE, clip, type ConfigKey, type Cwd, type EnvEntry, type ParsedServer, type ServerProblem } from './types'

export interface ServerCtx {
  format: 'native' | 'claude'
  /** 清单声明的配置键;没声明的 `${user_config.K}` 按敏感算 */
  config: Map<string, ConfigKey>
  /** 家目录:家目录内的绝对路径 command → bad_command */
  home?: string
}

const DANGEROUS_EXACT = new Set([
  'PATH', 'HOME', 'SHELL', 'ENV', 'ZDOTDIR', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'GCONV_PATH', 'GLIBC_TUNABLES', 'JAVA_TOOL_OPTIONS', 'BASH_ENV', 'TMPDIR', 'TMP', 'TEMP', 'IFS', 'PROMPT_COMMAND', 'PS4',
  'OPENSSL_CONF', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', '__PROTO__', 'CONSTRUCTOR', 'PROTOTYPE',
])
const DANGEROUS_PREFIX = ['SSL_CERT_', 'LD_', 'DYLD_', 'PYTHON', 'PERL', 'RUBY', 'GIT_', 'MFFAI_', 'ELECTRON_', 'BASH_FUNC_']

/** 大小写不敏感:`node_options`、`http_proxy` 一样算 */
export function dangerousEnvName(name: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return true
  const u = name.toUpperCase()
  return DANGEROUS_EXACT.has(u) || u.endsWith('_PROXY') || u === 'PROXY' || DANGEROUS_PREFIX.some(p => u.startsWith(p))
}

const PATH_VARS: [RegExp, string][] = [
  [/\$\{(?:CLAUDE|MFF)_PLUGIN_ROOT\}/g, '${PLUGIN_ROOT}'],
  [/\$\{(?:CLAUDE|MFF)_PLUGIN_DATA\}/g, '${PLUGIN_DATA}'],
  [/\$\{(?:CLAUDE|MFF)_PROJECT_DIR\}/g, '${PROJECT_DIR}'],
]
const KNOWN = new Set(['PLUGIN_ROOT', 'PLUGIN_DATA', 'PROJECT_DIR'])

/** 路径变量写成符号形式,不展开:展开后哈希跨机器不稳 */
export function symbolize(s: string): string {
  let out = s
  for (const [re, to] of PATH_VARS) out = out.replace(re, to)
  return out
}

type Ref = { kind: 'path'; name: string } | { kind: 'config'; key: string } | { kind: 'var'; key: string }

function refsOf(s: string): Ref[] {
  const out: Ref[] = []
  for (const m of s.matchAll(/\$\{([^}]{0,200})\}/g)) {
    const inner = m[1]
    const cfg = /^user_config\.([A-Za-z_][A-Za-z0-9_]{0,63})$/.exec(inner)
    if (cfg) out.push({ kind: 'config', key: cfg[1] })
    else if (KNOWN.has(inner)) out.push({ kind: 'path', name: inner })
    else out.push({ kind: 'var', key: /^([A-Za-z_][A-Za-z0-9_]{0,63})(?::?[-=?+].*)?$/.exec(inner)?.[1] ?? inner })
  }
  return out
}

const RUNTIMES = new Set(['docker', 'podman'])

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

function fetchKind(command: string, args: string[]): 'npm' | 'pypi' | null {
  const b = base(command)
  if (b === 'npx' || b === 'bunx') return 'npm'
  if (b === 'uvx') return 'pypi'
  if (b === 'pnpm' && args[0] === 'dlx') return 'npm'
  if (b === 'bun' && args[0] === 'x') return 'npm'
  return null
}

const SUGGESTED = { npm: ['registry.npmjs.org'], pypi: ['pypi.org', 'files.pythonhosted.org'] }

/** 命令检查。返回 problem 或 null */
function commandProblem(command: string, home: string | undefined): ServerProblem | null {
  if (command === '' || command.length > 1024 || /[\u0000-\u001f\u007f]/.test(command)) return 'bad_command'
  if (/\s/.test(command) || command.includes('\\')) return 'bad_command'
  let rel = command
  if (command.startsWith('${PLUGIN_ROOT}/')) rel = command.slice('${PLUGIN_ROOT}/'.length)
  else if (command.includes('${') || command.includes('$')) return 'bad_command'
  else if (command.startsWith('~')) return 'bad_command'
  else if (command.startsWith('/')) {
    const parts = command.split('/')
    if (parts.includes('..') || parts.includes('.')) return 'bad_command'
    const h = home?.replace(/\/+$/, '')
    if (h && (command === h || command.startsWith(h + '/'))) return 'bad_command'
    return null
  }
  if (!rel.includes('/') && rel === command) return /^[A-Za-z0-9_.+-]+$/.test(command) && command !== '.' && command !== '..' ? null : 'bad_command'
  // 根内相对路径
  const stack: string[] = []
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (stack.pop() === undefined) return 'command_outside_root'
    } else stack.push(seg)
  }
  return stack.length === 0 ? 'bad_command' : null
}

export function parseServer(name: string, raw: unknown, ctx: ServerCtx): ParsedServer {
  const problems = new Set<ServerProblem>()
  const configRefs = new Set<string>()
  const empty = (): ParsedServer => ({
    name,
    command: '',
    args: [],
    env: [],
    fetchesAtRuntime: false,
    declared: null,
    suggestedHosts: [],
    problems: [...problems],
    configRefs: [],
  })

  if (!SERVER_NAME_RE.test(name) || PROTO_NAMES.has(name)) problems.add('name_invalid')
  if (!isObject(raw)) {
    problems.add('bad_command')
    return empty()
  }

  const type = typeof raw.type === 'string' ? raw.type : undefined
  const url = typeof raw.url === 'string' ? raw.url : undefined
  const cmd = typeof raw.command === 'string' ? raw.command : undefined
  if ((type !== undefined && type !== 'stdio') || (cmd === undefined && url !== undefined)) {
    return { ...empty(), problems: [], remote: { type: type ?? 'http', url: clip(url ?? '', 2000) } }
  }

  if (cmd === undefined) problems.add('bad_command')
  const command = symbolize(cmd ?? '')
  const cp = cmd === undefined ? null : commandProblem(command, ctx.home)
  if (cp) problems.add(cp)
  if (cmd !== undefined && refsOf(command).some(r => r.kind !== 'path' || r.name !== 'PLUGIN_ROOT')) problems.add('bad_command')
  if (cmd !== undefined && RUNTIMES.has(base(command))) problems.add('runtime_unsupported')

  let args: string[] = []
  if (raw.args !== undefined) {
    if (Array.isArray(raw.args) && raw.args.length <= 256 && raw.args.every(a => typeof a === 'string' && a.length <= 4096)) args = raw.args.map(a => symbolize(a as string))
    else problems.add('bad_command')
  }
  for (const a of args)
    for (const r of refsOf(a)) {
      if (r.kind === 'var') {
        problems.add('arg_env_ref')
        configRefs.add(r.key)
      } else if (r.kind === 'config') {
        configRefs.add(r.key)
        if (ctx.config.get(r.key)?.sensitive !== false) problems.add('arg_env_ref')
      }
    }

  const env: EnvEntry[] = []
  if (raw.env !== undefined) {
    if (!isObject(raw.env)) problems.add('dangerous_env')
    else
      for (const [k, v] of Object.entries(raw.env)) {
        if (dangerousEnvName(k)) problems.add('dangerous_env')
        if (typeof v !== 'string' || v.includes('\0') || v.length > 65536) {
          problems.add('dangerous_env')
          continue
        }
        const value = symbolize(v)
        const refs = refsOf(value)
        let source: EnvEntry['source'] = 'literal'
        let required = false
        for (const r of refs) {
          if (r.kind === 'path') continue
          configRefs.add(r.key)
          if (r.kind === 'var') {
            source = 'secret'
            required = true
          } else {
            const decl = ctx.config.get(r.key)
            if (decl?.sensitive !== false) source = 'secret'
            else if (source !== 'secret') source = 'config'
            required = required || decl?.required === true
          }
        }
        env.push(source === 'literal' ? { name: k, source, required, value } : { name: k, source, required })
      }
  }
  env.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  let declared: ParsedServer['declared'] = null
  if (ctx.format === 'native') {
    const perm = isObject(raw.permissions) ? raw.permissions : {}
    const network = Array.isArray(perm.network) ? perm.network.filter((h): h is string => typeof h === 'string') : []
    const cwd: Cwd = perm.cwd === 'none' || perm.cwd === 'write' ? perm.cwd : 'read'
    declared = { network: [...new Set(network)].sort(), cwd }
  }

  const kind = cmd === undefined ? null : fetchKind(command, args)
  return {
    name,
    command,
    args,
    env,
    fetchesAtRuntime: kind !== null,
    declared,
    suggestedHosts: kind ? SUGGESTED[kind] : [],
    problems: [...problems],
    configRefs: [...configRefs].sort(),
  }
}
