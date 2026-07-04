import { describe, it, expect } from 'vitest'
import { createNotifyBridge } from './notifyBridge'
import type { NotifyCfg, BuiltNotification } from './notifier'
import type { EngineEvent, RunState, PendingAction } from '@shared/types'

const CFG: NotifyCfg = { enabled: true, confirm: true, input: true, done: true }

function harness(cfg: NotifyCfg = CFG, focused = false) {
  const sent: BuiltNotification[] = []
  const bridge = createNotifyBridge({ getCfg: () => cfg, isFocused: () => focused, notify: n => sent.push(n) })
  return { bridge, sent }
}

const runUpdate = (over: Partial<RunState>): EngineEvent =>
  ({ type: 'run:update', run: { id: 'r', workspaceName: 'blog', workspacePath: '/w/blog', status: 'run', stages: [], pending: [], ...over } as RunState })

const confirmAction = (id: string): PendingAction =>
  ({ id, kind: 'confirm', agentId: 'a', agentName: 'Claude', wsName: 'blog', title: '是否允许写入?' })

describe('createNotifyBridge', () => {
  it('notifies confirm/input, resolving workspacePath from a prior run:update', () => {
    const { bridge, sent } = harness()
    bridge(runUpdate({}))                              // learns blog → /w/blog
    bridge({ type: 'pending:add', action: confirmAction('p1') })
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe('blog · 需要确认')
    expect(sent[0].route.workspacePath).toBe('/w/blog')
  })

  it('deduplicates the same pending id', () => {
    const { bridge, sent } = harness()
    bridge({ type: 'pending:add', action: confirmAction('p1') })
    bridge({ type: 'pending:add', action: confirmAction('p1') })
    expect(sent).toHaveLength(1)
  })

  it('ignores select (only confirm/input notify)', () => {
    const { bridge, sent } = harness()
    bridge({ type: 'pending:add', action: { id: 'p', kind: 'select', agentId: 'a', agentName: 'x', wsName: 'blog', title: 't', options: [] } })
    expect(sent).toHaveLength(0)
  })

  it('does not fire a done notification here (completion arrives via the chat done path)', () => {
    const { bridge, sent } = harness()
    bridge(runUpdate({ status: 'run' }))
    bridge(runUpdate({ status: 'ok' }))
    expect(sent).toHaveLength(0)
  })

  it('suppresses everything while focused', () => {
    const { bridge, sent } = harness(CFG, true)
    bridge(runUpdate({}))
    bridge({ type: 'pending:add', action: confirmAction('p1') })
    expect(sent).toHaveLength(0)
  })
})
