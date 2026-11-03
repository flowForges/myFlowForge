// Qoder:没有 OS 沙箱,靠 05 包起来(04 spec §8.2)。argv 决定它拿到什么权限,测试逐字钉住
import { join } from 'node:path'
import {
  classifyOutcome, modelArgs, parseObject, promptStdin, record, requireAbsolute, text, usageEvents,
  type Adapter, type BuildInput, type RunEvent,
} from './types'

/** bin/、settings.json、external-commands/ 不在内:写了它们,下次在沙箱外运行就是任意代码执行(C4) */
const WRITABLE = ['.auth', 'logs', 'projects', 'tmp', 'cache', '.cache']

const NO_WEB = ['WebFetch', 'WebSearch', 'ImageSearch', 'CronCreate', 'ImageGen'].flatMap(t => ['--disallowed-tools', t])

function modeArgs(i: BuildInput): string[] {
  if (i.readOnly) {
    return ['--permission-mode', 'dont_ask', '--tools', 'Read', 'Grep', 'Glob', '--disallowed-tools', 'Edit', '--disallowed-tools', 'Write', '--disallowed-tools', 'Bash']
  }
  // 只有边界确实是沙箱时才跳过它自己的权限检查
  if (i.isolation === 'wrapped') return ['--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions', ...NO_WEB]
  return ['--permission-mode', 'accept_edits', ...NO_WEB]
}

function blockEvents(b: Record<string, unknown>): RunEvent[] {
  if (b.type === 'text') {
    const final = text(b.text)
    return final ? [{ kind: 'final', text: final }] : []
  }
  if (b.type === 'thinking') {
    const think = text(b.thinking)
    return think ? [{ kind: 'progress', progress: 'think', text: think }] : []
  }
  if (b.type !== 'tool_use') return []
  const name = text(b.name)
  if (!name) return []
  const input = record(b.input)
  const file = text(input?.file_path)
  const detail = text(input?.command) ?? file
  const tool: RunEvent = { kind: 'progress', progress: 'tool', text: detail ? `${name}: ${detail}` : name }
  return file && (name === 'Edit' || name === 'Write') ? [tool, { kind: 'files', files: [file] }] : [tool]
}

function assistantEvents(o: Record<string, unknown>): RunEvent[] {
  const message = record(o.message)
  const content = message?.content
  const blocks = Array.isArray(content) ? content.flatMap<Record<string, unknown>>(b => record(b) ?? []) : []
  const events = blocks.flatMap(blockEvents)
  const failed = o.error !== undefined && o.error !== null
  if (!message && !failed) return events
  if (!failed) return [...events, { kind: 'assistant', failed: false }]
  const said = blocks.flatMap(b => (b.type === 'text' ? (text(b.text) ?? []) : [])).at(-1)
  const auth = o.error === 'authentication_failed'
  const error: RunEvent = { kind: 'error', message: said ?? text(o.error) ?? 'assistant error', ...(auth ? { auth } : {}) }
  return [...events, error, { kind: 'assistant', failed: true }]
}

/**
 * 只有 subtype:"success" 且 is_error 不存在或恰好是 false 才算完成。subtype 单独不可信:
 * 未登录时是 success + is_error:true(spec §2);光秃秃的 result、其他形状的 is_error 都不算成功。
 * 不要求 is_error 一定在:app 测试里的成功行没有它,登录后的真实形状还没录到
 */
function resultEvents(o: Record<string, unknown>): RunEvent[] {
  const final = text(o.result)
  const notError = o.is_error === undefined || o.is_error === false
  const failed = !notError || (o.subtype !== undefined && o.subtype !== 'success')
  return [
    ...(final ? [{ kind: 'final', text: final } as const] : []),
    ...usageEvents(o.usage, 'cache_read_input_tokens'),
    ...(failed ? [{ kind: 'error', message: final ?? text(o.subtype) ?? 'result' } as const] : []),
    ...(o.subtype === 'success' && notError ? [{ kind: 'completed' } as const] : []),
  ]
}

export const qoderAdapter: Adapter = {
  id: 'qoder',
  bin: 'qodercli',
  toolName: 'delegate_qoder',
  label: 'Qoder',
  isolationKind: 'wrap',
  passEnv: [],
  allowRead: home => [join(home, '.qoder', '.auth')],
  allowWrite: home => WRITABLE.map(d => join(home, '.qoder', d)),
  hosts: ['*.qoder.sh', '*.qoder.com', '*.qoder.com.cn', '*.qoder.ai'],

  buildArgs(i) {
    return {
      args: [
        '-p', '--output-format', 'stream-json', '--cwd', requireAbsolute(i.cwd, 'cwd'), '--strict-mcp-config', '--setting-sources', 'user',
        ...modeArgs(i),
        ...modelArgs(i.model),
      ],
      stdin: promptStdin(i),
    }
  },

  parseLine(line) {
    const o = parseObject(line)
    if (!o) return []
    if (o.type === 'system' && o.subtype === 'init') {
      const id = text(o.session_id)
      return id ? [{ kind: 'native', id }] : []
    }
    if (o.type === 'assistant') return assistantEvents(o)
    return o.type === 'result' ? resultEvents(o) : []
  },

  classify: s => classifyOutcome(s, s.completed && s.assistantError !== true),

  loginArgs: ['status', '-o', 'json'],
  parseLogin(out) {
    const loggedIn = parseObject(out.trim())?.logged_in
    if (typeof loggedIn !== 'boolean') return 'unknown'
    return loggedIn ? 'ok' : 'missing'
  },
}
