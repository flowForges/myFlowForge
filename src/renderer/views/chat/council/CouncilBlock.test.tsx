import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { CouncilBlock, type CouncilControls } from './CouncilBlock'
import type { ChatMessage, ProviderInfo } from '@shared/types'
import type { CouncilSeat, CouncilState, CouncilStatus, CouncilStage } from '@shared/council'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'GPT-6' }] },
]

const A: CouncilSeat = { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' }
const B: CouncilSeat = { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' }
const L: CouncilSeat = { ...A, id: 'leader:claude:opus' }

function state(status: CouncilStatus, over: Partial<CouncilState> = {}): CouncilState {
  return {
    id: 'c1', workspacePath: '/ws', sessionId: 's1', status, round: 1, totalRounds: 2, speaking: [],
    startedAt: Date.now() - 125_000, elapsedMs: 125_000,
    config: { topic: '要不要把状态管理换成单一 store 呢,大家怎么看', attachments: [], seats: [A, B], leader: L, mode: { kind: 'rounds', rounds: 2 } },
    ...over,
  }
}

const topic: ChatMessage = { id: 'c1:topic', who: 'user', text: '要不要把状态管理换成单一 store 呢,大家怎么看', ts: '2026-10-21T10:00:00Z', council: { id: 'c1', stage: 'topic' } }
function ai(seat: CouncilSeat, round: number, stage: CouncilStage, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `c1:${round}:${seat.id}:${stage}`, who: 'ai', text, provider: seat.provider, model: seat.label,
    ts: '2026-10-21T10:01:00Z', council: { id: 'c1', seat: seat.id, round, stage }, ...extra,
  }
}

function controls(): CouncilControls {
  return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), followup: vi.fn(), choose: vi.fn() }
}

const finalMsg = ai(L, 2, 'final', '结论正文', {
  councilResult: { conclusion: '采用单一 store', candidates: [], disagreements: [] },
})

function renderBlock(messages: ChatMessage[], st?: CouncilState, streaming: string[] = [], ctl = controls()) {
  render(<CouncilBlock id="c1" messages={messages} state={st} streamingIds={new Set(streaming)} providers={providers} controls={ctl} />)
  return ctl
}

const toggle = () => document.querySelector('.council-head') as HTMLButtonElement

describe('CouncilBlock', () => {
  it('header: topic first 20 chars · seats · rounds · minutes', () => {
    renderBlock([topic], state('running'))
    expect(toggle().textContent).toBe('AI 共商 · 要不要把状态管理换成单一 store 呢 · 2 方 · 1 轮 · 2 分钟')
  })

  it('running block is expanded, with status bar, round label and the speaking seat', () => {
    const answering = ai(A, 1, 'answer', '一半')
    renderBlock([topic, answering], state('running', { speaking: [A.id] }), [answering.id])
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const bar = document.querySelector('.council-status')!
    expect(bar).not.toBeNull()
    expect(bar.textContent).toContain('第 1 / 2 轮')
    expect(bar.querySelector(`[data-speaking="${A.id}"]`)).not.toBeNull()
    expect(bar.querySelector(`[data-speaking="${B.id}"]`)).toBeNull()
    expect(bar.textContent).toContain('02:0')
  })

  it('consensus mode (totalRounds null) shows 第 x 轮 without a total', () => {
    renderBlock([topic], state('running', { totalRounds: null, round: 3 }))
    expect(document.querySelector('.council-status')!.textContent).toContain('第 3 轮')
    expect(document.querySelector('.council-status')!.textContent).not.toContain('/')
  })

  it('暂停 → pause; paused shows 继续 → resume; 结束 → stop(finalize)', () => {
    const ctl = renderBlock([topic], state('running'))
    fireEvent.click(screen.getByRole('button', { name: '暂停' }))
    expect(ctl.pause).toHaveBeenCalledWith('c1')
    fireEvent.click(screen.getByRole('button', { name: '结束' }))
    expect(ctl.stop).toHaveBeenCalledWith('c1', 'finalize')
  })

  it('paused: 继续 resumes', () => {
    const ctl = renderBlock([topic], state('paused'))
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(ctl.resume).toHaveBeenCalledWith('c1', undefined)
  })

  it('finalizing: 结束 aborts', () => {
    const ctl = renderBlock([topic], state('finalizing'))
    expect(screen.queryByRole('button', { name: '暂停' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '结束' }))
    expect(ctl.stop).toHaveBeenCalledWith('c1', 'abort')
  })

  it('paused after a leader failure: can pick another leader and resume with it', () => {
    const failed = ai(L, 1, 'failed', '')
    const ctl = renderBlock([topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'), failed], state('paused'))
    fireEvent.click(screen.getByRole('button', { name: /👑/ }))
    fireEvent.click(document.querySelector('.council-status [data-cprov="codex"]')!)
    fireEvent.click(document.querySelector('.council-status [data-cmodel="gpt-6"]')!)
    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    expect(ctl.resume).toHaveBeenCalledWith('c1', { id: 'leader:codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' })
  })

  it('elapsed ticks each second while running', () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      renderBlock([topic], state('running', { startedAt: now - 10_000, elapsedMs: 10_000 }))
      expect(document.querySelector('.council-elapsed')!.textContent).toBe('00:10')
      act(() => { vi.advanceTimersByTime(3000) })
      expect(document.querySelector('.council-elapsed')!.textContent).toBe('00:13')
    } finally {
      vi.useRealTimers()
    }
  })

  it('done block is collapsed: header + result card only', () => {
    renderBlock([topic, ai(A, 1, 'answer', '甲的回答'), ai(B, 1, 'answer', '乙的回答'), finalMsg], state('done', { round: 2 }))
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.council-status')).toBeNull()
    expect(document.querySelector('.council-grid')).toBeNull()
    expect(screen.queryByText('甲的回答')).toBeNull()
    expect(document.querySelector('.council-result')).not.toBeNull()
    expect(screen.getByText('采用单一 store')).toBeTruthy()
  })

  it('toggle expands a collapsed block', () => {
    renderBlock([topic, ai(A, 1, 'answer', '甲的回答'), ai(B, 1, 'answer', '乙的回答'), finalMsg], state('done', { round: 2 }))
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('甲的回答')).toBeTruthy()
  })

  it('round 1: one grid card per seat; later rounds as rows; dividers per round; leader summary card', () => {
    renderBlock([
      topic, ai(A, 1, 'answer', '甲一'), ai(B, 1, 'answer', '乙一'), ai(L, 1, 'summary', '第一轮小结'),
      ai(A, 2, 'critique', '甲二'),
    ], state('running', { round: 2 }))
    const cards = document.querySelectorAll('.council-grid .council-card')
    expect(cards).toHaveLength(2)
    expect(Array.from(cards).map(c => c.getAttribute('data-seat'))).toEqual([A.id, B.id])
    expect(document.querySelectorAll('.council-divider')).toHaveLength(2)
    expect(document.querySelector('.council-summary')!.textContent).toContain('第一轮小结')
    expect(document.querySelector(`.council-row[data-seat="${A.id}"]`)!.textContent).toContain('甲二')
  })

  it('a failed seat shows a muted chip with no body text', () => {
    renderBlock([topic, ai(A, 1, 'answer', '甲一'), ai(B, 1, 'failed', '残留文本')], state('running'))
    const failed = document.querySelector(`.council-failed[data-seat="${B.id}"]`)!
    expect(failed).not.toBeNull()
    expect(failed.textContent).not.toContain('残留文本')
    expect(failed.querySelector('.ans')).toBeNull()
  })

  it('votes render as compact badges; interjections as user rows', () => {
    renderBlock([
      topic, ai(A, 1, 'answer', 'x'), ai(B, 1, 'answer', 'y'),
      { id: 'c1:interject:1', who: 'user', text: '插一句', ts: '2026-10-21T10:02:00Z', council: { id: 'c1', round: 1, stage: 'interject' } },
      ai(A, 1, 'consensus-vote', '同意'), ai(B, 1, 'consensus-vote', '不同意,还有风险'),
    ], state('running', { totalRounds: null }))
    expect(document.querySelector('.council-interject')!.textContent).toContain('插一句')
    const badges = document.querySelectorAll('.council-vote')
    expect(badges).toHaveLength(2)
    expect(badges[0].getAttribute('data-vote')).toBe('agree')
    expect(badges[1].getAttribute('data-vote')).toBe('disagree')
  })

  it('fallback: no councilResult → final message text is rendered', () => {
    renderBlock([topic, ai(L, 2, 'final', '没有结构的最终结论')], state('done', { round: 2 }))
    expect(screen.getByText('没有结构的最终结论')).toBeTruthy()
  })

  it('done: follow-up input posts followup(id, q, all); target select lists each seat', () => {
    const ctl = renderBlock([topic, ai(A, 1, 'answer', 'x'), ai(B, 1, 'answer', 'y'), finalMsg], state('done', { round: 2 }))
    const select = document.querySelector('.council-followup select') as HTMLSelectElement
    expect(Array.from(select.options).map(o => o.value)).toEqual(['all', A.id, B.id])
    const input = document.querySelector('.council-followup textarea, .council-followup input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '再说说风险' } })
    fireEvent.click(screen.getByRole('button', { name: '追问' }))
    expect(ctl.followup).toHaveBeenCalledWith('c1', '再说说风险', 'all')
  })

  it('header shows at least 1 minute once time has elapsed', () => {
    renderBlock([topic], state('paused', { elapsedMs: 20_000 }))
    expect(toggle().textContent).toContain('· 1 分钟')
  })

  const fuQ = (n: number): ChatMessage => ({ id: `c1:followup:${n}`, who: 'user', text: `问${n}`, ts: '2026-10-21T10:05:00Z', council: { id: 'c1', round: 2, stage: 'followup' } })
  const fuA = (seat: CouncilSeat, n: number): ChatMessage => ({ ...ai(seat, 2, 'followup', `答${n}`), id: `c1:2:${seat.id}:followup:${n}` })
  const doneBase = [topic, ai(A, 1, 'answer', 'x'), ai(B, 1, 'answer', 'y'), finalMsg]
  const fuInput = () => document.querySelector('.council-followup input') as HTMLInputElement
  const fuBtn = () => screen.getByRole('button', { name: '追问' }) as HTMLButtonElement

  it('follow-up input is disabled while an answer is streaming', () => {
    const a = fuA(A, 1)
    renderBlock([...doneBase, fuQ(1), a], state('done', { round: 2, speaking: [A.id] }), [a.id])
    expect(fuInput().disabled).toBe(true)
    expect(fuBtn().disabled).toBe(true)
  })

  it('after asking 全体, stays disabled until every seat has answered', async () => {
    const ctl = controls()
    ;(ctl.followup as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    const st = state('done', { round: 2 })
    const { rerender } = render(<CouncilBlock id="c1" messages={doneBase} state={st} streamingIds={new Set()} providers={providers} controls={ctl} />)
    fireEvent.change(fuInput(), { target: { value: '问1' } })
    fireEvent.click(fuBtn())
    await waitFor(() => expect(fuInput().value).toBe(''))
    expect(fuInput().disabled).toBe(true)
    rerender(<CouncilBlock id="c1" messages={[...doneBase, fuQ(1), fuA(A, 1)]} state={st} streamingIds={new Set()} providers={providers} controls={ctl} />)
    expect(fuInput().disabled).toBe(true)
    rerender(<CouncilBlock id="c1" messages={[...doneBase, fuQ(1), fuA(A, 1), fuA(B, 1)]} state={st} streamingIds={new Set()} providers={providers} controls={ctl} />)
    expect(fuInput().disabled).toBe(false)
  })

  it('a rejected follow-up keeps the typed question', async () => {
    const ctl = controls()
    ;(ctl.followup as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    renderBlock(doneBase, state('done', { round: 2 }), [], ctl)
    fireEvent.change(fuInput(), { target: { value: '再说说风险' } })
    fireEvent.click(fuBtn())
    await waitFor(() => expect(ctl.followup).toHaveBeenCalled())
    await waitFor(() => expect(fuInput().disabled).toBe(false))
    expect(fuInput().value).toBe('再说说风险')
  })

  it('no follow-up input while running', () => {
    renderBlock([topic], state('running'))
    expect(document.querySelector('.council-followup')).toBeNull()
  })
})
