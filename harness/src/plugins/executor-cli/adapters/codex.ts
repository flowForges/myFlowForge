// Codex:翻译成权限档(04 spec §8.1)。argv 决定它拿到什么权限,测试逐字钉住
import { normalize } from 'node:path'
import {
  classifyOutcome, modelArgs, parseObject, promptStdin, record, requireAbsolute, text, usageEvents,
  type Adapter, type BuildInput, type RunEvent,
} from './types'

const PROFILE = 'mffai'

const TOML_ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r' }

/** TOML basic string */
export function tomlString(s: string): string {
  // eslint-disable-next-line no-control-regex
  const body = s.replace(/["\\\u0000-\u001f\u007f]/g, c => TOML_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${body}"`
}

/** 同一路径只留一种写法:重复键是非法 TOML,而 Codex 解析不了 -c 的值时不保证报错 */
function pathKey(p: string, what: string): string {
  const n = normalize(requireAbsolute(p, what))
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n
}

/**
 * 实测 0.154:路径里有 `* ? [ ]` 时 Codex 按 glob 解释,none 悄悄失效且不报错,read 直接拒绝(exit 1)。
 * `{ }` 只测过 `{p}`(按字面),`{a,b}` 没测:实测前按这一类算,代价只是多问一次
 */
const GLOB = /[*?[\]{}]/
export const PATH_GLOB_GAP = 'codex_path_glob'

const atOrUnder = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`)

/**
 * 相对路径直接抛:悄悄丢掉就是丢掉一条 deny,原样写进去又可能撞上 `:root`。
 * 最具体的条目赢,所以 none 里或 none 本身的 read 不能写:写了就把那个文件放开了
 */
function profilePaths(i: Pick<BuildInput, 'denyRead' | 'readOnlyPaths'>): { none: string[]; read: string[] } {
  const none = [...new Set(i.denyRead.filter(p => p !== '').map(p => pathKey(p, 'denyRead')))]
  const read = [...new Set(i.readOnlyPaths.filter(p => p !== '').map(p => pathKey(p, 'readOnlyPaths')))]
  return { none, read: read.filter(r => !none.some(n => atOrUnder(r, n))) }
}

/**
 * cwd 可写,但这些不行(实测 0.154,`codex sandbox`,见 spec §8.1):
 * - `.codex`、`.qoder`:Codex 主进程不在沙箱里,cwd 的配置它自己会加载。`.codex` 现在它自己也保护,这里不靠版本行为;
 * - 嵌套仓库的 hooks、config:Codex 只保护 cwd 那一层 `.git`。glob 只支持 none,所以这两处读也不行,嵌套仓库里跑不了 git;
 *   `*`+`/**` 不含 cwd 自己的 `.git`,那里只读不是 none。
 * `:project_roots` 里的相对路径按 `-C` 算
 */
const PROJECT_ROOTS = '":project_roots"={"."="write",".codex"="read",".qoder"="read","*/**/.git/hooks/**"="none","*/**/.git/config"="none"}'

/** 真实运行和自检共用这一个。带 glob 字符的 read 不写:那样的运行已经按 none 算,写了只会让 Codex 退出 */
export function filesystemMap(i: Pick<BuildInput, 'denyRead' | 'keepRead' | 'readOnlyPaths' | 'readOnly'>): string {
  const { none, read } = profilePaths(i)
  // 用户的 deny read 落在 git 目录上时 none 留着
  const keep = [...new Set((i.keepRead ?? []).map(p => pathKey(p, 'keepRead')))].filter(k => !GLOB.test(k) && !read.includes(k) && !none.includes(k))
  const entries = [
    '":root"="read"',
    ...(i.readOnly ? [] : [PROJECT_ROOTS]),
    '":tmpdir"="write"',
    ...none.map(p => `${tomlString(p)}="none"`),
    ...read.filter(p => !GLOB.test(p)).map(p => `${tomlString(p)}="read"`),
    ...keep.map(p => `${tomlString(p)}="read"`),
  ]
  return `{${entries.join(',')}}`
}

function profileGaps(i: Pick<BuildInput, 'cwd' | 'denyRead' | 'readOnlyPaths'>): string[] {
  const { none, read } = profilePaths(i)
  return [i.cwd, ...none, ...read].some(p => GLOB.test(p)) ? [PATH_GLOB_GAP] : []
}

function configFlags(i: Pick<BuildInput, 'denyRead' | 'keepRead' | 'readOnlyPaths' | 'readOnly' | 'network'>): string[] {
  return [
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', `default_permissions="${PROFILE}"`,
    '-c', `permissions.${PROFILE}.filesystem=${filesystemMap(i)}`,
    '-c', `permissions.${PROFILE}.network={enabled=${i.network === true}}`,
  ]
}

/** 自检每一行的预期:true = 要成功(r=0),false = 要失败。监听方有没有收到连接由 detect.ts 另看 */
const SELF_TEST_ROWS: Record<string, boolean> = {
  secret_read: false,
  cwd_write: true,
  outside_write: false,
  git_write: false,
  nested_git_hook: false,
  nested_git_config: false,
  codex_config_write: false,
  qoder_config_write: false,
  tmp_write: true,
  rule_write: false,
  rule_read: false,
  secret_dir_read: false,
  net_connect: false,
}

/**
 * 从仓库子目录跑的那一遍:`:project_roots` 要是 cwd 而不是 git 顶层。
 * 是顶层的话,仓库子目录里的会话委派出去就能写整个仓库
 */
const SELF_TEST_SUBDIR_ROWS: Record<string, boolean> = {
  sub_cwd_write: true,
  parent_write: false,
  sibling_write: false,
}

/** 只读那一遍:没有 :project_roots,cwd 写不了但读得了 */
const SELF_TEST_READ_ONLY_ROWS: Record<string, boolean> = {
  ro_cwd_write: false,
  ro_cwd_read: true,
}

function failedRows(rows: Record<string, boolean>, out: string): string[] {
  const seen = new Map<string, boolean>()
  for (const [, row, r] of out.matchAll(/^(\w+) r=(\d+)\s*$/gm)) {
    const good = (r === '0') === rows[row]
    seen.set(row, (seen.get(row) ?? true) && good)
  }
  return Object.keys(rows).filter(row => seen.get(row) !== true)
}

function itemEvents(type: string, item: Record<string, unknown>): RunEvent[] {
  if (item.type === 'command_execution') {
    const command = text(item.command)
    return command ? [{ kind: 'progress', progress: 'tool', text: command }] : []
  }
  if (type !== 'item.completed') return []
  if (item.type === 'error') {
    // 只是警告:失败看 turn.failed 和 turn.completed(spec §2)
    const message = text(item.message)
    return message ? [{ kind: 'progress', progress: 'think', text: message }] : []
  }
  if (item.type === 'agent_message') {
    const final = text(item.text)
    return final ? [{ kind: 'final', text: final }] : []
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const files = item.changes.flatMap(c => text(record(c)?.path) ?? [])
    return files.length > 0 ? [{ kind: 'files', files }, { kind: 'progress', progress: 'file', text: files.join(', ') }] : []
  }
  return []
}

function errorMessage(o: Record<string, unknown>, fallback: string): string {
  return text(o.message) ?? text(record(o.error)?.message) ?? text(o.error) ?? fallback
}

export const codexAdapter: Adapter = {
  id: 'codex',
  bin: 'codex',
  toolName: 'delegate_codex',
  label: 'Codex',
  isolationKind: 'translate',
  passEnv: ['CODEX_HOME'],
  allowRead: () => [],
  allowWrite: () => [],
  hosts: [],

  profileGaps,

  buildArgs(i) {
    const gaps = profileGaps(i)
    if (gaps.length > 0 && i.isolation !== 'none') throw new Error(`${gaps.join(',')}: isolation must be none`)
    return {
      args: [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
        '-C', requireAbsolute(i.cwd, 'cwd'),
        ...configFlags(i),
        ...modelArgs(i.model),
        '-',
      ],
      stdin: promptStdin(i),
      ...(gaps.length > 0 ? { unenforceable: gaps } : {}),
    }
  },

  parseLine(line) {
    const o = parseObject(line)
    if (!o) return []
    switch (o.type) {
      case 'thread.started': {
        const id = text(o.thread_id)
        return id ? [{ kind: 'native', id }] : []
      }
      case 'item.started':
      case 'item.completed': {
        const item = record(o.item)
        return item ? itemEvents(o.type, item) : []
      }
      case 'turn.completed':
        return [...usageEvents(o.usage, 'cached_input_tokens'), { kind: 'completed' }]
      case 'turn.failed':
        return [{ kind: 'error', message: errorMessage(o, o.type), fatal: true }]
      case 'error':
        return [{ kind: 'error', message: errorMessage(o, o.type) }]
      default:
        return []
    }
  },

  // 顶层 error 也可能只是重试计数(`Reconnecting... 2/5`):轮真的完成了就算成功。turn.failed 不算重试
  classify: s => classifyOutcome(s, s.completed && !s.errors.some(e => e.fatal)),

  loginArgs: ['login', 'status'],
  parseLogin(out) {
    const t = out.toLowerCase()
    // 否定在前:"not logged in" 里包含 "logged in"
    if (/not logged in|no credentials|please (run )?login|未登录|没有登录/.test(t)) return 'missing'
    return /logged in|已登录/.test(t) ? 'ok' : 'unknown'
  },

  selfTest(i) {
    const readOnly = i.readOnly === true
    const flags = configFlags({ denyRead: [...(i.denyRead ?? []), i.secret], readOnlyPaths: i.readOnlyPaths ?? [], readOnly, network: false })
    const rows = readOnly ? SELF_TEST_READ_ONLY_ROWS : i.subdir ? SELF_TEST_SUBDIR_ROWS : SELF_TEST_ROWS
    return {
      args: ['sandbox', '-C', requireAbsolute(i.dir, 'dir'), ...flags, ...i.flags, '-P', PROFILE, '--'],
      parse: out => failedRows(rows, out),
    }
  },
}
