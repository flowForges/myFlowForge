import { describe, it, expect } from 'vitest'
import {
  logStamp, appendLines, chatEventToLines, pendingAddToLine,
  agentLogToLine, agentStateLine, changeItemToLine, run2LogToLine,
  MAX_LOGS,
} from './logReducer'
import type { ChatEvent, EngineEvent, ChangeItem } from '@shared/types'
import type { RunLogLine } from '../../main/run/controller'

// ── logStamp ──────────────────────────────────────────────────────────────────

describe('logStamp', () => {
  it('formats single-digit h/m/s with zero padding', () => {
    const d = new Date(2024, 0, 1, 1, 2, 3)
    expect(logStamp(d)).toBe('01:02:03')
  })

  it('formats double-digit h/m/s correctly', () => {
    const d = new Date(2024, 0, 1, 23, 59, 58)
    expect(logStamp(d)).toBe('23:59:58')
  })

  it('formats midnight', () => {
    const d = new Date(2024, 0, 1, 0, 0, 0)
    expect(logStamp(d)).toBe('00:00:00')
  })
})

// ── appendLines / MAX_LOGS cap ────────────────────────────────────────────────

describe('appendLines', () => {
  it('appends lines and keeps total when under MAX_LOGS', () => {
    const existing = [{ id: '1', t: '00:00:00', level: 'exec' as const, src: 'a', color: '', text: 'x', streaming: false }]
    const incoming = [{ id: '2', t: '00:00:01', level: 'out' as const, src: 'b', color: '', text: 'y', streaming: false }]
    const result = appendLines(existing, incoming)
    expect(result).toHaveLength(2)
  })

  it('caps to MAX_LOGS by dropping oldest when overflow', () => {
    // Build 450 existing lines
    const existing = Array.from({ length: 450 }, (_, i) => ({
      id: String(i), t: '00:00:00', level: 'exec' as const, src: 'x', color: '', text: `msg${i}`, streaming: false,
    }))
    const result = appendLines(existing, [])
    expect(result).toHaveLength(MAX_LOGS)
    // Newest entries are kept
    expect(result[result.length - 1].id).toBe('449')
    // Oldest entries dropped
    expect(result[0].id).toBe('50')
  })

  it('caps when total exceeds MAX_LOGS via incoming', () => {
    const existing = Array.from({ length: 390 }, (_, i) => ({
      id: String(i), t: '00:00:00', level: 'exec' as const, src: 'x', color: '', text: `msg${i}`, streaming: false,
    }))
    const incoming = Array.from({ length: 20 }, (_, i) => ({
      id: String(400 + i), t: '00:00:00', level: 'out' as const, src: 'x', color: '', text: `new${i}`, streaming: false,
    }))
    const result = appendLines(existing, incoming)
    expect(result).toHaveLength(MAX_LOGS)
  })
})

// ── chatEventToLines ──────────────────────────────────────────────────────────

describe('chatEventToLines', () => {
  const now = new Date(2024, 0, 1, 10, 30, 0)

  it('maps user event to a user-level line', () => {
    const e: ChatEvent = {
      workspacePath: '/ws',
      sessionId: 's1',
      type: 'user',
      message: { id: 'msg1', who: 'user', text: 'hello', ts: '' },
    }
    const lines = chatEventToLines(e, now)
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('user')
    expect(lines[0].src).toBe('你')
    expect(lines[0].text).toBe('hello')
    expect(lines[0].color).toBe('var(--accent)')
    expect(lines[0].t).toBe('10:30:00')
    expect(lines[0].streaming).toBe(false)
  })

  it('maps error event to an out-level line with error prefix', () => {
    const e: ChatEvent = {
      workspacePath: '/ws',
      sessionId: 's1',
      type: 'error',
      id: 'e1',
      error: 'something went wrong',
    }
    const lines = chatEventToLines(e, now)
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('out')
    expect(lines[0].src).toBe('主代理')
    expect(lines[0].text).toBe('错误: something went wrong')
  })

  it('returns empty array for unhandled event types', () => {
    const e: ChatEvent = { workspacePath: '/ws', sessionId: 's1', type: 'assistant-start', id: 'x', model: 'm' }
    expect(chatEventToLines(e, now)).toHaveLength(0)
  })
})

// ── pendingAddToLine ──────────────────────────────────────────────────────────

describe('pendingAddToLine', () => {
  const now = new Date(2024, 0, 1, 9, 0, 0)

  it('maps confirm kind with label 请求确认', () => {
    const e: Extract<EngineEvent, { type: 'pending:add' }> = {
      type: 'pending:add',
      action: { id: 'p1', kind: 'confirm', agentId: 'a1', agentName: '设计师', wsName: 'ws', title: '覆盖 theme.ts' },
    }
    const line = pendingAddToLine(e, now)
    expect(line.level).toBe('exec')
    expect(line.src).toBe('设计师')
    expect(line.text).toBe('请求确认：覆盖 theme.ts')
    expect(line.t).toBe('09:00:00')
  })

  it('maps input kind with label 请求输入', () => {
    const e: Extract<EngineEvent, { type: 'pending:add' }> = {
      type: 'pending:add',
      action: { id: 'p2', kind: 'input', agentId: 'a2', agentName: '执行者', wsName: 'ws', title: '请输入分支名' },
    }
    const line = pendingAddToLine(e, now)
    expect(line.text).toBe('请求输入：请输入分支名')
  })

  it('maps select kind with label 请求选择', () => {
    const e: Extract<EngineEvent, { type: 'pending:add' }> = {
      type: 'pending:add',
      action: { id: 'p3', kind: 'select', agentId: 'a3', agentName: '规划师', wsName: 'ws', title: '选择模型', options: [] },
    }
    const line = pendingAddToLine(e, now)
    expect(line.text).toBe('请求选择：选择模型')
  })

  it('falls back to 主代理 when agentName is empty', () => {
    const e: Extract<EngineEvent, { type: 'pending:add' }> = {
      type: 'pending:add',
      action: { id: 'p4', kind: 'confirm', agentId: 'a4', agentName: '', wsName: 'ws', title: '确认' },
    }
    const line = pendingAddToLine(e, now)
    expect(line.src).toBe('主代理')
  })
})

// ── agentLogToLine ────────────────────────────────────────────────────────────

describe('agentLogToLine', () => {
  const now = new Date(2024, 0, 1, 12, 0, 0)

  it('maps ok level to out', () => {
    const e: Extract<EngineEvent, { type: 'agent:log' }> = {
      type: 'agent:log', agentId: 'agent-1',
      line: { ts: '', text: '完成分析', level: 'ok' },
    }
    const line = agentLogToLine(e, now)
    expect(line.level).toBe('out')
    expect(line.text).toBe('完成分析')
    expect(line.src).toBe('agent-1')
  })

  it('maps accent level to out', () => {
    const e: Extract<EngineEvent, { type: 'agent:log' }> = {
      type: 'agent:log', agentId: 'agent-2',
      line: { ts: '', text: '重要输出', level: 'accent' },
    }
    expect(agentLogToLine(e, now).level).toBe('out')
  })

  it('maps info level to exec', () => {
    const e: Extract<EngineEvent, { type: 'agent:log' }> = {
      type: 'agent:log', agentId: 'agent-3',
      line: { ts: '', text: '执行步骤', level: 'info' },
    }
    expect(agentLogToLine(e, now).level).toBe('exec')
  })

  it('maps run level to exec', () => {
    const e: Extract<EngineEvent, { type: 'agent:log' }> = {
      type: 'agent:log', agentId: 'agent-4',
      line: { ts: '', text: '正在运行', level: 'run' },
    }
    expect(agentLogToLine(e, now).level).toBe('exec')
  })
})

// ── agentStateLine ────────────────────────────────────────────────────────────

describe('agentStateLine', () => {
  const now = new Date(2024, 0, 1, 8, 0, 0)

  it('run state produces 执行中 text', () => {
    const line = agentStateLine('a1', '设计代理', 'run', now)
    expect(line.text).toBe('执行中')
    expect(line.level).toBe('exec')
    expect(line.src).toBe('设计代理')
    expect(line.color).toBe('var(--accent)')
  })

  it('ok state produces 完成 text', () => {
    const line = agentStateLine('a1', '设计代理', 'ok', now)
    expect(line.text).toBe('完成')
    expect(line.color).toBe('var(--ok)')
  })

  it('err state produces 失败 text', () => {
    const line = agentStateLine('a1', '设计代理', 'err', now)
    expect(line.text).toBe('失败')
    expect(line.color).toBe('var(--err)')
  })
})

// ── run2LogToLine ─────────────────────────────────────────────────────────────

describe('run2LogToLine', () => {
  const now = new Date(0)

  function makeLog(overrides: Partial<RunLogLine['line']> = {}): RunLogLine {
    return {
      laneId: 'design:root',
      stageKey: 'design',
      agentName: 'Codex',
      line: { ts: '', text: '技术方案草拟', level: 'run', kind: 'think', ...overrides },
    }
  }

  it('maps kind:think to level:think, keeps src/text', () => {
    const line = run2LogToLine({ workspacePath: '/ws', log: makeLog({ kind: 'think' }) }, now)
    expect(line.level).toBe('think')
    expect(line.src).toBe('Codex')
    expect(line.text).toBe('技术方案草拟')
    expect(line.color).toBe('var(--accent)')
    expect(line.streaming).toBe(false)
  })

  it('maps kind:tool to level:exec', () => {
    const line = run2LogToLine({ workspacePath: '/ws', log: makeLog({ kind: 'tool' }) }, now)
    expect(line.level).toBe('exec')
  })

  it('maps kind:output to level:out', () => {
    const line = run2LogToLine({ workspacePath: '/ws', log: makeLog({ kind: 'output' }) }, now)
    expect(line.level).toBe('out')
  })

  it('maps kind:file to level:file', () => {
    const line = run2LogToLine({ workspacePath: '/ws', log: makeLog({ kind: 'file' }) }, now)
    expect(line.level).toBe('file')
  })

  it('falls back to level:out when kind is undefined', () => {
    const log = makeLog()
    delete (log.line as { kind?: string }).kind
    const line = run2LogToLine({ workspacePath: '/ws', log }, now)
    expect(line.level).toBe('out')
  })

  it('produces a unique id including laneId', () => {
    const line = run2LogToLine({ workspacePath: '/ws', log: makeLog() }, now)
    expect(line.id).toContain('run2')
    expect(line.id).toContain('design:root')
  })

  it('gives distinct ids to two lines with the same non-empty ts, lane, and now', () => {
    // Real providers stamp ts at HH:MM:SS granularity → many lines share a ts within one second.
    // The monotonic seq must still make each React key unique (else fast streams drop lines).
    const log = makeLog({ ts: '12:00:00' })
    const a = run2LogToLine({ workspacePath: '/ws', log }, now)
    const b = run2LogToLine({ workspacePath: '/ws', log }, now)
    expect(a.id).not.toBe(b.id)
  })
})

// ── changeItemToLine ──────────────────────────────────────────────────────────

describe('changeItemToLine', () => {
  const now = new Date(2024, 0, 1, 14, 20, 30)

  it('maps A type to 新增', () => {
    const item: ChangeItem = { path: 'src/index.ts', type: 'A', add: 10, del: 0 }
    const line = changeItemToLine(item, '/cwd', now)
    expect(line.level).toBe('file')
    expect(line.text).toBe('新增 src/index.ts')
    expect(line.t).toBe('14:20:30')
    expect(line.color).toBe('var(--warn)')
  })

  it('maps M type to 修改', () => {
    const item: ChangeItem = { path: 'src/app.ts', type: 'M', add: 5, del: 2 }
    const line = changeItemToLine(item, '/cwd', now)
    expect(line.text).toBe('修改 src/app.ts')
  })

  it('maps D type to 删除', () => {
    const item: ChangeItem = { path: 'old.ts', type: 'D', add: 0, del: 20 }
    const line = changeItemToLine(item, '/cwd', now)
    expect(line.text).toBe('删除 old.ts')
  })
})
