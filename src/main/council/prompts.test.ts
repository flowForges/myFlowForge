import { describe, it, expect } from 'vitest'
import type { CouncilConfig, CouncilSeat } from '@shared/council'
import type { Utterance } from './transcript'
import {
  labelLine, answerPrompt, critiquePrompt, summaryPrompt, consensusDraftPrompt,
  consensusVotePrompt, finalPrompt, followupPrompt,
} from './prompts'

const s1: CouncilSeat = { id: 's1', provider: 'claude', model: 'opus', label: 'Claude · opus' }
const s2: CouncilSeat = { id: 's2', provider: 'codex', model: '6.1', label: 'Codex · 6.1' }
const cfg: CouncilConfig = {
  topic: '怎么设计缓存失效策略', attachments: [], seats: [s1, s2], leader: s1,
  mode: { kind: 'rounds', rounds: 2 },
}
const u = (seat: CouncilSeat, round: number, stage: Utterance['stage'], text: string): Utterance =>
  ({ seat: seat.id, label: seat.label, round, stage, text })

describe('prompts', () => {
  it('labelLine prefixes 【label · ...】', () => {
    const l = labelLine(u(s2, 1, 'answer', '正文'))
    expect(l).toContain('【Codex · 6.1】')
    expect(l).toContain('正文')
  })

  it('answerPrompt has topic + materials, no other seat label, read-only', () => {
    const p = answerPrompt(cfg, '<<MATERIALS>>', s1)
    expect(p).toContain(cfg.topic)
    expect(p).toContain('<<MATERIALS>>')
    expect(p).not.toContain('Codex · 6.1')
    expect(p).toContain('不要修改')
  })

  it('critiquePrompt includes deltas, summary and anti-sycophancy rule', () => {
    const summary = u(s1, 1, 'summary', 'SUMMARY_TEXT')
    const d = [u(s2, 2, 'critique', 'DELTA_TEXT')]
    const p = critiquePrompt(cfg, s1, 2, summary, d, true, '')
    expect(p).toContain(labelLine(d[0]))
    expect(p).toContain('SUMMARY_TEXT')
    expect(p).toContain('至少指出一个具体的问题或风险')
    expect(p).toContain('完全同意')
  })

  it('round 2 prompt omits round-1 answers when a summary exists', () => {
    const summary = u(s1, 1, 'summary', 'SUMMARY_TEXT')
    const r1 = u(s2, 1, 'answer', 'ROUND1_ANSWER_TEXT')
    const r2 = u(s2, 2, 'critique', 'ROUND2_TEXT')
    expect(r1.text).toBeTruthy()
    const p = critiquePrompt(cfg, s1, 2, summary, [r2], true, '')
    expect(p).not.toContain('ROUND1_ANSWER_TEXT')
    expect(p).toContain('ROUND2_TEXT')
  })

  it('resumed controls whether topic and materials repeat', () => {
    const a = critiquePrompt(cfg, s1, 2, undefined, [], false, '<<MAT>>')
    expect(a).toContain(cfg.topic)
    expect(a).toContain('<<MAT>>')
    const b = critiquePrompt(cfg, s1, 2, undefined, [], true, '<<MAT>>')
    expect(b).not.toContain(cfg.topic)
    expect(b).not.toContain('<<MAT>>')
  })

  it('summary and consensus draft forbid taking a stance', () => {
    const items = [u(s1, 1, 'answer', 'x')]
    expect(summaryPrompt(cfg, 1, items)).toContain('不表态')
    expect(summaryPrompt(cfg, 1, items)).toContain('不加入自己的观点')
    expect(consensusDraftPrompt(cfg, 1, items)).toContain('不表态')
    expect(consensusDraftPrompt(cfg, 1, items)).toContain('不加入自己的观点')
  })

  it('vote prompt asks for 同意/不同意 and includes the draft', () => {
    const p = consensusVotePrompt(s1, 'DRAFT_TEXT')
    expect(p).toContain('DRAFT_TEXT')
    expect(p).toContain('同意')
    expect(p).toContain('不同意')
  })

  it('finalPrompt has the fence and CouncilResult keys, and unresolved points', () => {
    const p = finalPrompt(cfg, [u(s1, 1, 'summary', 'S1')], [u(s2, 2, 'critique', 'LAST')], ['UNRESOLVED_POINT'])
    expect(p).toContain('```forge:council-result')
    for (const k of ['conclusion', 'candidates', 'recommended', 'disagreements', 'supporters', 'dissenters', 'pros', 'cons', 'points'])
      expect(p).toContain(k)
    expect(p).toContain('UNRESOLVED_POINT')
    expect(p).toContain('S1')
    expect(p).toContain('LAST')
  })

  it('followupPrompt has question and delta', () => {
    const p = followupPrompt('QUESTION?', [u(s2, 3, 'interject', 'DELTA')])
    expect(p).toContain('QUESTION?')
    expect(p).toContain('DELTA')
  })
})
