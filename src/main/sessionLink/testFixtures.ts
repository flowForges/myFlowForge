// 测试用的外部记录样例(形状取自 sessionImport 夹具 + 真实文件的字段结构)。只在临时目录里写。
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const jsonl = (rows: unknown[]): string => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r)) + '\n').join('')

export function tempFile(name: string, body: string): string {
  const f = join(mkdtempSync(join(tmpdir(), 'sl-')), name)
  writeFileSync(f, body)
  return f
}
export const append = (f: string, body: string): void => appendFileSync(f, body)

// ---- Claude(Qoder 假定同格式) ----
export const claudeUser = (uuid: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', uuid, message: { role: 'user', content: text }, timestamp: '2026-06-01T00:01:00.000Z', cwd: '/Users/me/proj', entrypoint: 'cli', ...extra })
export const claudeAssistant = (uuid: string, content: unknown[], stop_reason: string | null = 'end_turn') =>
  ({ type: 'assistant', uuid, message: { role: 'assistant', content, stop_reason }, timestamp: '2026-06-01T00:02:00.000Z', cwd: '/Users/me/proj' })
export const claudeToolResult = (uuid: string, id: string) =>
  ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, timestamp: '2026-06-01T00:02:30.000Z' })
export const claudeStopHook = (uuid: string) => ({ type: 'system', subtype: 'stop_hook_summary', uuid, timestamp: '2026-06-01T00:03:00.000Z' })

export const claudeTurnRows = (): unknown[] => [
  { type: 'mode', mode: 'normal' },
  claudeUser('u0', '<local-command-caveat>noise', { isMeta: true }),
  claudeUser('u1', '帮我重构登录流程'),
  claudeAssistant('a1', [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la src' } }], 'tool_use'),
  claudeToolResult('r1', 'tu1'),
  claudeAssistant('a2', [{ type: 'text', text: '好的,这是方案' }]),
  claudeStopHook('s1'),
  { type: 'last-prompt', lastPrompt: 'x' },
]

// ---- Codex ----
const cx = (type: string, payload: Record<string, unknown>, ts = '2026-06-15T21:01:00.000Z') => ({ timestamp: ts, type, payload })
export const codexMeta = (cwd = '/Users/me/work') => cx('session_meta', { id: 'uuid-cx', timestamp: '2026-06-15T21:00:00.000Z', cwd })
export const codexMsg = (role: string, text: string, id?: string) =>
  cx('response_item', { type: 'message', role, ...(id ? { id } : {}), content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] })
export const codexEvent = (type: string) => cx('event_msg', { type })

export const codexTurnRows = (): unknown[] => [
  codexMeta(),
  codexMsg('developer', '<permissions>noise'),
  cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>\n</environment_context>' }] }),
  codexEvent('task_started'),
  cx('turn_context', { cwd: '/Users/me/work2', model: 'm' }),
  codexMsg('user', '修复构建错误', 'm1'),
  cx('response_item', { type: 'reasoning', id: 'rs1', summary: [] }),
  cx('response_item', { type: 'function_call', id: 'fc1', call_id: 'c1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm run build'] }) }),
  cx('response_item', { type: 'function_call_output', call_id: 'c1', output: 'done' }),
  codexMsg('assistant', '已修复', 'm2'),
  codexEvent('token_count'),
  codexEvent('task_complete'),
]
