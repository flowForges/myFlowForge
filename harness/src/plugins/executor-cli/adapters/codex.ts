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
 * 真实运行和自检共用这一个。相对路径直接抛:悄悄丢掉就是丢掉一条 deny,
 * 原样写进去又可能撞上 `:root`。同一路径两边都有时 none 赢,只收窄
 */
export function filesystemMap(i: Pick<BuildInput, 'denyRead' | 'readOnlyPaths' | 'readOnly'>): string {
  const none = new Set(i.denyRead.filter(p => p !== '').map(p => pathKey(p, 'denyRead')))
  const read = new Set(i.readOnlyPaths.filter(p => p !== '').map(p => pathKey(p, 'readOnlyPaths')))
  const entries = [
    '":root"="read"',
    ...(i.readOnly ? [] : ['":project_roots"={"."="write"}']),
    '":tmpdir"="write"',
    ...[...none].map(p => `${tomlString(p)}="none"`),
    ...[...read].filter(p => !none.has(p)).map(p => `${tomlString(p)}="read"`),
  ]
  return `{${entries.join(',')}}`
}

function configFlags(i: Pick<BuildInput, 'denyRead' | 'readOnlyPaths' | 'readOnly' | 'network'>): string[] {
  return [
    '-c', 'approval_policy="never"',
    '-c', 'web_search="disabled"',
    '-c', `default_permissions="${PROFILE}"`,
    '-c', `permissions.${PROFILE}.filesystem=${filesystemMap(i)}`,
    '-c', `permissions.${PROFILE}.network={enabled=${i.network}}`,
  ]
}

/** 自检每一行的预期:true = 要成功(r=0),false = 要失败。监听方有没有收到连接由 detect.ts 另看 */
const SELF_TEST_ROWS: Record<string, boolean> = {
  secret_read: false,
  cwd_write: true,
  outside_write: false,
  git_write: false,
  tmp_write: true,
  net_connect: false,
}

function failedRows(out: string): string[] {
  const seen = new Map<string, boolean>()
  for (const [, row, r] of out.matchAll(/^(\w+) r=(\d+)\s*$/gm)) {
    const good = (r === '0') === SELF_TEST_ROWS[row]
    seen.set(row, (seen.get(row) ?? true) && good)
  }
  return Object.keys(SELF_TEST_ROWS).filter(row => seen.get(row) !== true)
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

  buildArgs(i) {
    return {
      args: [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
        '-C', requireAbsolute(i.cwd, 'cwd'),
        ...configFlags(i),
        ...modelArgs(i.model),
        '-',
      ],
      stdin: promptStdin(i),
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
      case 'error':
        return [{ kind: 'error', message: errorMessage(o, o.type) }]
      default:
        return []
    }
  },

  // 顶层 error 也可能只是重试计数(`Reconnecting... 2/5`):轮真的完成了就算成功
  classify: s => classifyOutcome(s, s.completed),

  loginArgs: ['login', 'status'],
  parseLogin(out) {
    const t = out.toLowerCase()
    // 否定在前:"not logged in" 里包含 "logged in"
    if (/not logged in|no credentials|please (run )?login|未登录|没有登录/.test(t)) return 'missing'
    return /logged in|已登录/.test(t) ? 'ok' : 'unknown'
  },

  selfTest(i) {
    const flags = configFlags({ denyRead: [...(i.denyRead ?? []), i.secret], readOnlyPaths: [], readOnly: false, network: false })
    return {
      args: ['sandbox', '-C', requireAbsolute(i.dir, 'dir'), ...flags, ...i.flags, '-P', PROFILE, '--'],
      parse: failedRows,
    }
  },
}
