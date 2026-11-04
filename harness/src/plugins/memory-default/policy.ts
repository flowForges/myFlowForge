// 受众 → 记忆能读到什么、写到哪(06 spec §9)。这是唯一判断处:工具、contextFor、接入都调它
import type { SessionInfo } from '../../kernel/sessions'

export interface Scope {
  /** ['owner'] 或 [`session:${id}`];不认识的会话是 [] */
  read: string[]
  write: 'diary' | 'session'
  source: 'model' | 'schedule' | 'group'
  injectCore: boolean
  canPropose: boolean
  extractable: boolean
  countsForHabits: boolean
}

const NOBODY: Scope = { read: [], write: 'session', source: 'group', injectCore: false, canPropose: false, extractable: false, countsForHabits: false }

export function scopeOf(session: SessionInfo | undefined): Scope {
  if (!session) return { ...NOBODY }
  if (session.audience !== 'owner') return { ...NOBODY, read: [`session:${session.sessionId}`] }
  // 定时任务的"用户消息"是写好的,没人在场说"记住",也不算用户今天说的话。sessions 把不认识的 origin 归到这里
  const present = session.origin !== 'schedule'
  return {
    read: ['owner'],
    write: 'diary',
    source: present ? 'model' : 'schedule',
    injectCore: true,
    canPropose: present,
    extractable: present,
    countsForHabits: present,
  }
}
