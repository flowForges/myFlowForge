import { describe, it, expect } from 'vitest'
import { withLastMessageAt } from './sessionsView'
import type { SessionsFile } from '@shared/types'

const file: SessionsFile = {
  activeSessionId: 's1',
  sessions: [
    { id: 's1', title: '一', mode: 'chat', createdAt: 1000 },
    { id: 's2', title: '二', mode: 'chat', createdAt: 2000 },
  ],
}

describe('withLastMessageAt', () => {
  it('按消息文件 mtime 附加 lastMessageAt', () => {
    const out = withLastMessageAt('/ws', file, (_w, id) => (id === 's1' ? 9000 : 8000))
    expect(out.sessions.map(s => s.lastMessageAt)).toEqual([9000, 8000])
  })
  it('没有消息文件的会话回落到 createdAt', () => {
    const out = withLastMessageAt('/ws', file, () => undefined)
    expect(out.sessions.map(s => s.lastMessageAt)).toEqual([1000, 2000])
  })
  it('不改动入参,其余字段原样保留', () => {
    const out = withLastMessageAt('/ws', file, () => 5000)
    expect(out.activeSessionId).toBe('s1')
    expect(file.sessions[0].lastMessageAt).toBeUndefined()
  })
  it('空列表不炸', () => {
    expect(withLastMessageAt('/ws', { activeSessionId: '', sessions: [] }, () => 1).sessions).toEqual([])
  })
})
