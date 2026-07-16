import { describe, it, expect } from 'vitest'
import { derivePetAction } from './derivePetAction'
import type { RunState, PendingAction } from '@shared/types'

const run = (over: Partial<RunState>): RunState => ({
  id: 'r', workspaceName: 'w', workspacePath: '/w', status: 'run', stages: [], pending: [], projects: [], ...over,
} as RunState)
const confirm = { id: 'c', kind: 'confirm', agentId: 'a', agentName: 'A', wsName: 'w', title: 'ok?' } as PendingAction
const input = { id: 'i', kind: 'input', agentId: 'a', agentName: 'A', wsName: 'w', title: 'name?' } as PendingAction

describe('derivePetAction', () => {
  it('idle when nothing happening', () => {
    expect(derivePetAction(null, [])).toBe('idle')
  })
  it('jumps when hovering an otherwise-idle pet (matches Codex hover reaction)', () => {
    expect(derivePetAction(null, [], undefined, { hovered: true })).toBe('jumping')
  })
  it('waiting on a confirm or input gate (overrides hover)', () => {
    expect(derivePetAction(null, [confirm], undefined, { hovered: true })).toBe('waiting')
    expect(derivePetAction(null, [input])).toBe('waiting')
  })
  it('failed on a run error', () => {
    expect(derivePetAction(run({ status: 'err' }), [])).toBe('failed')
  })
  it('review when a review stage is running', () => {
    expect(derivePetAction(run({ status: 'run', stages: [{ key: 'review', name: '代码 CR', state: 'run', agents: [] }] as never }), [])).toBe('review')
  })
  it('running while a run is active (non-review stage)', () => {
    expect(derivePetAction(run({ status: 'run', stages: [{ key: 'develop', name: 'Dev', state: 'run', agents: [] }] as never }), [])).toBe('running')
  })
  it('running when chat is busy', () => {
    expect(derivePetAction(null, [], { busy: true, confirmPending: false })).toBe('running')
  })
  it('jumping on completion', () => {
    expect(derivePetAction(run({ status: 'ok' }), [])).toBe('jumping')
    expect(derivePetAction(null, [], { busy: false, confirmPending: false, justDone: true })).toBe('jumping')
  })
  it('hover does not override an active run', () => {
    expect(derivePetAction(run({ status: 'run' }), [], undefined, { hovered: true })).toBe('running')
  })
})
