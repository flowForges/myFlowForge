import { describe, it, expect } from 'vitest'
import { agentLogToLine } from './logReducer'

const D0 = new Date(0)
const mk = (line: any) => ({ type: 'agent:log', agentId: 'a', line } as any)

describe('agentLogToLine kind→console level', () => {
  it('kind 优先: think→think, tool→exec, file→file, output→out', () => {
    expect(agentLogToLine(mk({ ts: '', text: 'x', level: 'info', kind: 'think' }), D0).level).toBe('think')
    expect(agentLogToLine(mk({ ts: '', text: 'x', level: 'accent', kind: 'tool' }), D0).level).toBe('exec')
    expect(agentLogToLine(mk({ ts: '', text: 'x', level: 'accent', kind: 'file' }), D0).level).toBe('file')
    expect(agentLogToLine(mk({ ts: '', text: 'x', level: 'ok', kind: 'output' }), D0).level).toBe('out')
  })
  it('无 kind 时退回旧 level 映射', () => {
    expect(agentLogToLine(mk({ ts: '', text: 'x', level: 'accent' }), D0).level).toBe('out')
    expect(agentLogToLine(mk({ ts: '', text: 'x', level: 'info' }), D0).level).toBe('exec')
  })
})
