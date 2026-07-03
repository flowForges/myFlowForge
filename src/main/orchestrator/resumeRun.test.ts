import { describe, it, expect } from 'vitest'
import { planResume } from './resumeRun'
import type { StageSpec } from './orchestrator'
import type { RunState, StageRuntime } from '@shared/types'

const spec = (key: string, provider = 'claude', model = 'opus-4.8'): StageSpec => ({ key, name: key, provider, model })
const stage = (key: string, state: StageRuntime['state'], agentIds: string[] = [key]): StageRuntime => ({
  key, name: key, state,
  agents: agentIds.map(id => ({ id, name: id, role: key, provider: 'claude', model: 'opus-4.8', state, logs: [] })),
})
const prior = (stages: StageRuntime[], status: RunState['status'] = 'err'): RunState => ({
  id: 'r1', workspaceName: 'ws', workspacePath: '/ws', status, projects: [], stages, pending: [],
})

const ALL = [spec('requirement'), spec('design'), spec('develop'), spec('verify')]

describe('planResume', () => {
  it('resumes from the first non-ok stage, keeping completed stages and their handoffs', () => {
    const p = prior([stage('requirement', 'ok', ['a1']), stage('design', 'err', ['a2'])])
    const handoff = (id: string) => (id === 'a1' ? '需求已澄清:目标X' : undefined)
    const plan = planResume(p, ALL, handoff)!
    expect(plan.completedStages.map(s => s.key)).toEqual(['requirement'])
    expect(plan.remainingSpecs.map(s => s.key)).toEqual(['design', 'develop', 'verify'])
    expect(plan.priorBriefs).toEqual([{ agentName: 'a1', summary: '需求已澄清:目标X', artifacts: [] }])
  })

  it('treats a stage that never ran (missing from prior) as the resume point', () => {
    // Only requirement completed; design/develop/verify never started.
    const p = prior([stage('requirement', 'ok', ['a1'])])
    const plan = planResume(p, ALL, () => 'brief')!
    expect(plan.completedStages.map(s => s.key)).toEqual(['requirement'])
    expect(plan.remainingSpecs.map(s => s.key)).toEqual(['design', 'develop', 'verify'])
  })

  it('applies a cross-model override to the remaining stages only', () => {
    const p = prior([stage('requirement', 'ok', ['a1']), stage('design', 'err', ['a2'])])
    const plan = planResume(p, ALL, () => 'b', { provider: 'codex', model: 'gpt-5' })!
    expect(plan.remainingSpecs.every(s => s.provider === 'codex' && s.model === 'gpt-5')).toBe(true)
    // completed stages are historical — untouched
    expect(plan.completedStages[0].agents[0].provider).toBe('claude')
  })

  it('returns null when every stage already completed (nothing to resume)', () => {
    const p = prior([stage('requirement', 'ok'), stage('design', 'ok'), stage('develop', 'ok'), stage('verify', 'ok')], 'ok')
    expect(planResume(p, ALL, () => 'b')).toBeNull()
  })

  it('collects handoffs from every agent of every completed stage', () => {
    const p = prior([
      stage('requirement', 'ok', ['a1']),
      stage('design', 'ok', ['d:p1', 'd:p2']),
      stage('develop', 'err', ['dev']),
    ])
    const map: Record<string, string> = { a1: 'req', 'd:p1': 'design p1', 'd:p2': 'design p2' }
    const plan = planResume(p, ALL, id => map[id])!
    expect(plan.priorBriefs.map(b => b.summary)).toEqual(['req', 'design p1', 'design p2'])
    expect(plan.remainingSpecs.map(s => s.key)).toEqual(['develop', 'verify'])
  })

  it('skips missing handoffs rather than emitting empty briefs', () => {
    const p = prior([stage('requirement', 'ok', ['a1', 'a2']), stage('design', 'err')])
    const plan = planResume(p, ALL, id => (id === 'a1' ? 'has' : undefined))!
    expect(plan.priorBriefs).toEqual([{ agentName: 'a1', summary: 'has', artifacts: [] }])
  })

  // The design gate fires AFTER the stage is marked 'ok'. If the user cancels at that gate, the design
  // stage is 'ok' but was never approved — resume MUST re-run design (re-fire the gate) instead of
  // skipping into code with an un-approved plan.
  it('re-runs a gated stage that finished ok but whose review gate was NOT approved', () => {
    const p = prior([stage('requirement', 'ok', ['a1']), stage('design', 'ok', ['d1'])])
    const plan = planResume(p, ALL, () => 'b', undefined, () => false)!
    expect(plan.completedStages.map(s => s.key)).toEqual(['requirement'])
    expect(plan.remainingSpecs.map(s => s.key)).toEqual(['design', 'develop', 'verify'])
  })

  it('treats a gated stage as done once its gate was approved', () => {
    const p = prior([stage('requirement', 'ok', ['a1']), stage('design', 'ok', ['d1'])])
    const plan = planResume(p, ALL, () => 'b', undefined, key => key === 'design')!
    expect(plan.completedStages.map(s => s.key)).toEqual(['requirement', 'design'])
    expect(plan.remainingSpecs.map(s => s.key)).toEqual(['develop', 'verify'])
  })

  it('a non-gated ok stage is never re-run even when gateApproved is false for it', () => {
    // requirement is not gated → gateApproved(false) must not force a re-run of it.
    const p = prior([stage('requirement', 'ok', ['a1']), stage('design', 'ok', ['d1']), stage('develop', 'err', ['dev'])])
    const plan = planResume(p, ALL, () => 'b', undefined, key => key === 'design')!
    expect(plan.remainingSpecs.map(s => s.key)).toEqual(['develop', 'verify'])
  })
})
