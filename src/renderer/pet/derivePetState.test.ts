import { describe, it, expect } from 'vitest'
import { derivePetState } from './derivePetState'
import type { RunState, PendingAction } from '@shared/types'

const run = (status: RunState['status']): RunState => ({
  id: 'r1', workspaceName: 'ws', workspacePath: '/tmp/ws', status,
  projects: [], stages: [], pending: []
})
const confirm: PendingAction = { id: 'p1', kind: 'confirm', agentId: 'a', agentName: 'D', wsName: 'ws', title: '覆盖 theme.ts' }
const input: PendingAction = { id: 'p2', kind: 'input', agentId: 'a', agentName: 'D', wsName: 'ws', title: '输入分支' }

describe('derivePetState', () => {
  it('returns idle when there is no run and nothing pending', () => {
    expect(derivePetState(null, [])).toBe('idle')
  })
  it('returns working when run is running', () => {
    expect(derivePetState(run('run'), [])).toBe('working')
  })
  it('returns done when run is ok', () => {
    expect(derivePetState(run('ok'), [])).toBe('done')
  })
  it('returns idle for wait / err run with no pending', () => {
    expect(derivePetState(run('wait'), [])).toBe('idle')
    expect(derivePetState(run('err'), [])).toBe('idle')
  })
  it('prioritizes confirm over everything', () => {
    expect(derivePetState(run('run'), [input, confirm])).toBe('confirm')
  })
  it('prioritizes input over working', () => {
    expect(derivePetState(run('run'), [input])).toBe('input')
  })
  it('shows working when a chat turn is streaming even without an orchestrated run', () => {
    expect(derivePetState(null, [], { busy: true, confirmPending: false })).toBe('working')
  })
  it('shows confirm when a chat permission is pending', () => {
    expect(derivePetState(null, [], { busy: false, confirmPending: true })).toBe('confirm')
  })
  it('defaults chat activity to idle when omitted (back-compat)', () => {
    expect(derivePetState(null, [])).toBe('idle')
  })
})
