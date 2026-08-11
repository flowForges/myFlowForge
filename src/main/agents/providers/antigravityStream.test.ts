import { describe, it, expect } from 'vitest'
import { agyEnvelope, agyTurnTokens, agyContextTokens, parseAgyActions, toolTitle } from './antigravityStream'

// ★真机抓来的 result 事件(agy -p … --output-format stream-json,未登录那次)。字段名一个都没改 ——
// 这就是「信封 = event + 同名载荷」的原始证据。
const REAL_RESULT = JSON.parse('{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}')

describe('agyEnvelope', () => {
  it('按 event 取出同名字段里的载荷(不是 claude 那种平铺)', () => {
    expect(agyEnvelope({ event: 'step_update', step_update: { step_index: 3 } })).toEqual({ event: 'step_update', payload: { step_index: 3 } })
  })
  it('载荷缺失时给空对象,而不是炸掉整行', () => {
    expect(agyEnvelope({ event: 'init' })).toEqual({ event: 'init', payload: {} })
  })
  it('不是这个协议的行一律 null', () => {
    expect(agyEnvelope({ type: 'assistant' })).toBeNull()
    expect(agyEnvelope(null)).toBeNull()
    expect(agyEnvelope({ event: '' })).toBeNull()
  })
})

describe('parseAgyActions', () => {
  it('text_delta 是唯一的正文来源', () => {
    expect(parseAgyActions({ event: 'step_update', step_update: { text_delta: '你好' } }))
      .toEqual([{ kind: 'assistant', text: '你好' }])
  })

  it('conversation_id 冒出来就当会话 id(供 --conversation 续聊)', () => {
    const a = parseAgyActions({ event: 'step_update', step_update: { conversation_id: 'c-42', text_delta: 'x' } })
    expect(a[0]).toEqual({ kind: 'session', id: 'c-42' })
  })

  it('★result 只收尾,不吐正文 —— response 是整轮全文,再发一遍会把回答打印两遍', () => {
    const a = parseAgyActions({ event: 'result', result: { conversation_id: 'c-1', status: 'SUCCESS', response: '完整回答' } })
    expect(a).toEqual([
      { kind: 'session', id: 'c-1' },
      { kind: 'result', text: '完整回答', ok: true, error: undefined },
    ])
    expect(a.some(x => x.kind === 'assistant')).toBe(false)
  })

  it('真机那条 ERROR result:判为失败并带上原因', () => {
    const a = parseAgyActions(REAL_RESULT)
    expect(a).toEqual([{ kind: 'result', text: undefined, ok: false, error: 'authentication failed or timed out' }])
  })

  it('status 不是 ERROR 就算成功 —— 未来新增的成功态不该被误判', () => {
    expect(parseAgyActions({ event: 'result', result: { status: 'COMPLETED' } })[0]).toMatchObject({ kind: 'result', ok: true })
  })

  it('工具步:ACTIVE 出标题,DONE 配输出(按 step_index 配对)', () => {
    const start = parseAgyActions({ event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { file_path: '/a/b.ts' } } } })
    expect(start).toEqual([{ kind: 'tool', text: 'read_file · /a/b.ts', id: 'agy-2', name: 'read_file' }])
    const done = parseAgyActions({ event: 'step_update', step_update: { step_index: 2, state: 'DONE', tool_name: 'read_file', tool_info: { name: 'read_file', output: '文件内容' } } })
    expect(done).toEqual([{ kind: 'tool-result', id: 'agy-2', result: '文件内容', isError: false }])
  })

  it('工具报错时 isError 为真', () => {
    const a = parseAgyActions({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', tool_name: 'run_command', tool_info: { name: 'run_command', error: 'exit 1' } } })
    expect(a[0]).toMatchObject({ kind: 'tool-result', isError: true })
  })

  it('init 与不认识的事件都不产生动作', () => {
    expect(parseAgyActions({ event: 'init', init: { cwd: '/x', tools: [], permission_mode: 'accept-edits' } })).toEqual([{ kind: 'ignore' }])
    expect(parseAgyActions({ event: '未来新事件', 未来新事件: {} })).toEqual([{ kind: 'ignore' }])
    expect(parseAgyActions({ type: 'assistant', text: 'x' })).toEqual([{ kind: 'ignore' }])
  })
})

describe('用量', () => {
  it('thinking_tokens 计进输出,否则本轮输出会少一大截', () => {
    expect(agyTurnTokens({ event: 'result', result: { usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 7 } } }))
      .toEqual({ input: 10, output: 12 })
  })
  it('全零 / 没有 usage 时返回 undefined —— 宁可不显示,也不编一个数', () => {
    expect(agyTurnTokens(REAL_RESULT)).toBeUndefined()
    expect(agyTurnTokens({ event: 'result', result: {} })).toBeUndefined()
  })
  it('上下文取 total_tokens,零/缺失都不显示', () => {
    expect(agyContextTokens({ event: 'result', result: { usage: { total_tokens: 1234 } } })).toBe(1234)
    expect(agyContextTokens(REAL_RESULT)).toBeUndefined()
  })
})

describe('toolTitle', () => {
  it('带得上目标就带(路径/命令/查询)', () => {
    expect(toolTitle('read_file', { file_path: '/a.ts' })).toBe('read_file · /a.ts')
    expect(toolTitle('run_command', { command: 'ls -la' })).toBe('run_command · ls -la')
    expect(toolTitle('grep_search', { query: 'TODO' })).toBe('grep_search · TODO')
  })
  it('没有可读目标就只给工具名', () => {
    expect(toolTitle('manage_task', { foo: 1 })).toBe('manage_task')
    expect(toolTitle('manage_task', undefined)).toBe('manage_task')
  })
})
