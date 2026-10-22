import { describe, it, expect, vi, afterEach, onTestFinished } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { CouncilBlock, type CouncilControls } from './CouncilBlock'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ProviderInfo } from '@shared/types'
import type { CouncilSeat, CouncilState, CouncilStatus, CouncilStage } from '@shared/council'

// E:全屏 = 固定顶栏 + 唯一滚动的正文 + 固定底栏;追问框多行。

// ★css 在测试里被处理成空串,直接读源文件
const councilCss = readFileSync(join(__dirname, 'council.css'), 'utf8')
const ruleBody = (sel: string) => {
  const m = councilCss.match(new RegExp(sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

vi.mock('../markdown', () => ({
  Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>,
}))

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'GPT-6' }] },
]
const A: CouncilSeat = { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' }
const B: CouncilSeat = { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' }
const L: CouncilSeat = { ...A, id: 'leader:claude:opus' }

function state(status: CouncilStatus, over: Partial<CouncilState> = {}): CouncilState {
  return {
    id: 'c1', workspacePath: '/ws', sessionId: 's1', status, round: 1, totalRounds: 3, speaking: [],
    startedAt: Date.now() - 60_000, elapsedMs: 60_000,
    config: { topic: '议题', attachments: [], seats: [A, B], leader: L, mode: { kind: 'rounds', rounds: 3 } },
    ...over,
  }
}
const topic: ChatMessage = { id: 'c1:topic', who: 'user', text: '议题', ts: '2026-10-21T10:00:00Z', council: { id: 'c1', stage: 'topic' } }
function ai(seat: CouncilSeat, round: number, stage: CouncilStage, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `c1:${round}:${seat.id}:${stage}`, who: 'ai', text, provider: seat.provider, model: seat.label,
    ts: '2026-10-21T10:01:00Z', council: { id: 'c1', seat: seat.id, round, stage }, ...extra,
  }
}
const controls = (): CouncilControls => ({
  pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), followup: vi.fn(), choose: vi.fn(), interject: vi.fn(),
})
const finalMsg = ai(L, 2, 'final', '结论正文', { councilResult: { conclusion: '采用单一 store', candidates: [], disagreements: [] } })
const r1 = [ai(A, 1, 'answer', '甲一'), ai(B, 1, 'answer', '乙一'), ai(L, 1, 'summary', '小结一')]
const r2 = [ai(A, 2, 'critique', '甲二'), ai(B, 2, 'critique', '乙二')]

function renderBlock(messages: ChatMessage[], st?: CouncilState, ctl = controls()) {
  render(<CouncilBlock id="c1" messages={messages} state={st} streamingIds={new Set()} providers={providers} controls={ctl} />)
  return ctl
}
const goFullscreen = () => fireEvent.click(screen.getByRole('button', { name: '全屏' }))
const top = () => document.querySelector('.council-block.fullscreen > .council-fs-top') as HTMLElement
const body = () => document.querySelector('.council-block.fullscreen > .council-fs-body') as HTMLElement
const bottom = () => document.querySelector('.council-block.fullscreen > .council-fs-bottom') as HTMLElement | null

afterEach(() => { vi.restoreAllMocks() })

describe('CouncilBlock fullscreen layout', () => {
  it('top bar (title, status, controls, exit) sits outside the single scroll body', () => {
    renderBlock([topic, ...r1], state('running', { round: 2 }))
    goFullscreen()
    expect(top()).not.toBeNull()
    expect(body()).not.toBeNull()
    expect(body().contains(top())).toBe(false)
    expect(top().querySelector('.council-head')).not.toBeNull()
    expect(top().querySelector('.council-status')).not.toBeNull()
    expect(top().textContent).toContain('暂停')
    expect(top().textContent).toContain('结束')
    expect(body().querySelector('.council-grid')).not.toBeNull()
  })

  it('退出全屏 stays reachable after the body is scrolled: it lives in the top bar, not the scroller', () => {
    renderBlock([topic, ...r1, ...r2], state('running', { round: 2 }))
    goFullscreen()
    body().scrollTop = 2000
    fireEvent.scroll(body())
    const exit = screen.getByRole('button', { name: '退出全屏' })
    expect(exit.textContent).toContain('退出全屏')
    expect(top().contains(exit)).toBe(true)
    expect(body().contains(exit)).toBe(false)
    fireEvent.click(exit)
    expect(document.querySelector('.council-block')!.className).not.toContain('fullscreen')
  })

  it('css: overlay is a fixed flex column that does not scroll itself; only the body scrolls; no sticky', () => {
    const block = ruleBody('.council-block.fullscreen')
    expect(block).toMatch(/position:\s*fixed/)
    expect(block).toMatch(/flex-direction:\s*column/)
    expect(block).toMatch(/overflow:\s*hidden/)
    expect(block).toMatch(/-webkit-app-region:\s*no-drag/)
    const b = ruleBody('.council-block.fullscreen > .council-fs-body')
    expect(b).toMatch(/overflow:\s*auto/)
    expect(b).toMatch(/flex:\s*1/)
    expect(b).toMatch(/min-height:\s*0/)
    expect(councilCss).not.toMatch(/sticky/)
  })

  it('normal mode: no fullscreen-only bars', () => {
    renderBlock([topic, ...r1], state('running', { round: 2 }))
    expect(document.querySelector('.council-fs-nav')).toBeNull()
    expect(document.querySelector('.council-fs-bottom')).toBeNull()
  })
})

describe('CouncilBlock fullscreen bottom bar', () => {
  const area = () => bottom()!.querySelector('textarea') as HTMLTextAreaElement

  it('running: 插话 box submits interject on Enter; Shift+Enter does not', async () => {
    const ctl = renderBlock([topic, ...r1], state('running', { round: 2 }))
    ;(ctl.interject as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    goFullscreen()
    expect(area().placeholder).toBe('插话')
    expect(bottom()!.textContent).not.toContain('继续下一轮')
    fireEvent.change(area(), { target: { value: '考虑多机' } })
    fireEvent.keyDown(area(), { key: 'Enter', shiftKey: true })
    expect(ctl.interject).not.toHaveBeenCalled()
    fireEvent.keyDown(area(), { key: 'Enter' })
    expect(ctl.interject).toHaveBeenCalledWith('c1', '考虑多机')
    await waitFor(() => expect(area().value).toBe(''))
  })

  it('a rejected interjection keeps the text', async () => {
    const ctl = renderBlock([topic, ...r1], state('running', { round: 2 }))
    ;(ctl.interject as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    goFullscreen()
    fireEvent.change(area(), { target: { value: '别忘了并发' } })
    fireEvent.keyDown(area(), { key: 'Enter' })
    await waitFor(() => expect(ctl.interject).toHaveBeenCalled())
    await act(async () => {})
    expect(area().value).toBe('别忘了并发')
  })

  it('round break: supplement box + primary 继续下一轮 → resume', () => {
    const ctl = renderBlock([topic, ...r1], state('paused', { round: 2, waitingForUser: true }))
    goFullscreen()
    expect(area().placeholder).toBe('补充给下一轮的内容(可选)')
    const next = bottom()!.querySelector('button.council-ctl.primary') as HTMLButtonElement
    expect(next.textContent).toBe('继续下一轮')
    fireEvent.click(next)
    expect(ctl.resume).toHaveBeenCalledWith('c1')
  })

  it('round break: 继续下一轮 with typed text interjects first, then clears and resumes', async () => {
    const ctl = renderBlock([topic, ...r1], state('paused', { round: 2, waitingForUser: true }))
    ;(ctl.interject as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    goFullscreen()
    fireEvent.change(area(), { target: { value: '补一句' } })
    fireEvent.click(bottom()!.querySelector('button.council-ctl.primary')!)
    await waitFor(() => expect(ctl.resume).toHaveBeenCalledWith('c1'))
    expect(ctl.interject).toHaveBeenCalledWith('c1', '补一句')
    expect((ctl.interject as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
      .toBeLessThan((ctl.resume as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    expect(area().value).toBe('')
  })

  it('round break: 继续下一轮 keeps the text and does not resume when the interjection fails', async () => {
    const ctl = renderBlock([topic, ...r1], state('paused', { round: 2, waitingForUser: true }))
    ;(ctl.interject as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    goFullscreen()
    fireEvent.change(area(), { target: { value: '补一句' } })
    fireEvent.click(bottom()!.querySelector('button.council-ctl.primary')!)
    await waitFor(() => expect(ctl.interject).toHaveBeenCalled())
    await act(async () => {})
    expect(ctl.resume).not.toHaveBeenCalled()
    expect(area().value).toBe('补一句')
  })

  it('round break: 继续下一轮 with blank text resumes without interjecting', () => {
    const ctl = renderBlock([topic, ...r1], state('paused', { round: 2, waitingForUser: true }))
    goFullscreen()
    fireEvent.change(area(), { target: { value: '   ' } })
    fireEvent.click(bottom()!.querySelector('button.council-ctl.primary')!)
    expect(ctl.interject).not.toHaveBeenCalled()
    expect(ctl.resume).toHaveBeenCalledWith('c1')
  })

  it('round break: 继续下一轮 lives only in the bottom bar in fullscreen; normal mode keeps it in the status bar', () => {
    renderBlock([topic, ...r1], state('paused', { round: 2, waitingForUser: true }))
    expect(document.querySelector('.council-status')!.textContent).toContain('继续下一轮')
    goFullscreen()
    expect(document.querySelector('.council-status')!.textContent).not.toContain('继续下一轮')
    expect(screen.getAllByRole('button', { name: '继续下一轮' })).toHaveLength(1)
    expect(bottom()!.contains(screen.getByRole('button', { name: '继续下一轮' }))).toBe(true)
  })

  it('round break: supplement submit → interject', () => {
    const ctl = renderBlock([topic, ...r1], state('paused', { round: 2, waitingForUser: true }))
    ;(ctl.interject as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    goFullscreen()
    fireEvent.change(area(), { target: { value: '补一句' } })
    fireEvent.keyDown(area(), { key: 'Enter' })
    expect(ctl.interject).toHaveBeenCalledWith('c1', '补一句')
  })

  it('hidden when done (the follow-up box in the body is used)', () => {
    renderBlock([topic, ...r1, finalMsg], state('done', { round: 2 }))
    goFullscreen()
    expect(bottom()).toBeNull()
    expect(body().querySelector('.council-followup')).not.toBeNull()
  })

  it('hidden on a manual pause', () => {
    renderBlock([topic, ...r1], state('paused', { round: 2 }))
    goFullscreen()
    expect(bottom()).toBeNull()
  })
})

describe('CouncilBlock fullscreen scrolling', () => {
  it('cells scroll on their own only in normal mode', () => {
    renderBlock([topic, ...r1], state('running', { round: 2 }))
    const cellBody = () => document.querySelector(`.council-cell[data-seat="${A.id}"] .council-cell-body`)!
    const leaderBody = () => document.querySelector('.council-leader-card .council-cell-body')!
    expect(cellBody().classList.contains('council-cell-scroll')).toBe(true)
    expect(leaderBody().classList.contains('council-cell-scroll')).toBe(true)
    goFullscreen()
    expect(cellBody().classList.contains('council-cell-scroll')).toBe(false)
    expect(leaderBody().classList.contains('council-cell-scroll')).toBe(false)
    expect(ruleBody('.council-cell-scroll')).toMatch(/max-height:\s*420px/)
    expect(ruleBody('.council-cell-body')).not.toMatch(/max-height/)
  })

  it('jump chips scroll the body to each round divider and to the result card; 回到顶部 scrolls to 0', () => {
    const spy = vi.fn()
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = spy
    onTestFinished(() => { Element.prototype.scrollIntoView = orig })
    renderBlock([topic, ...r1, ...r2, finalMsg], state('done', { round: 2 }))
    goFullscreen()
    const nav = document.querySelector('.council-fs-top .council-fs-nav') as HTMLElement
    const chips = Array.from(nav.querySelectorAll('button')).map(b => b.textContent)
    expect(chips).toEqual(['第 1 轮', '第 2 轮', '结果', '回到顶部'])
    fireEvent.click(screen.getByRole('button', { name: '第 2 轮' }))
    expect(spy.mock.contexts.at(-1)).toBe(document.querySelector('.council-round-sec[data-round="2"] > .council-divider'))
    fireEvent.click(screen.getByRole('button', { name: '结果' }))
    expect(spy.mock.contexts.at(-1)).toBe(document.querySelector('.council-result'))
    body().scrollTop = 500
    fireEvent.click(screen.getByRole('button', { name: '回到顶部' }))
    expect(body().scrollTop).toBe(0)
  })

  it('no 结果 chip before a result exists', () => {
    renderBlock([topic, ...r1], state('running', { round: 2 }))
    goFullscreen()
    const nav = document.querySelector('.council-fs-nav') as HTMLElement
    expect(Array.from(nav.querySelectorAll('button')).map(b => b.textContent)).toEqual(['第 1 轮', '第 2 轮', '回到顶部'])
  })
})

describe('CouncilBlock follow-up box', () => {
  const fu = () => document.querySelector('.council-followup textarea') as HTMLTextAreaElement
  const doneMsgs = [topic, ...r1, finalMsg]

  it('multi-line textarea with placeholder, select on the left, primary 追问 button', () => {
    renderBlock(doneMsgs, state('done', { round: 2 }))
    expect(fu()).not.toBeNull()
    expect(fu().rows).toBe(3)
    expect(fu().placeholder).toBe('追问全体或某个讨论方…')
    const box = document.querySelector('.council-followup')!
    expect(box.firstElementChild!.tagName).toBe('SELECT')
    expect(screen.getByRole('button', { name: '追问' }).className).toContain('primary')
  })

  it('Enter submits (multi-line text intact); Shift+Enter does not', () => {
    const ctl = renderBlock(doneMsgs, state('done', { round: 2 }))
    ;(ctl.followup as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    fireEvent.change(fu(), { target: { value: '第一行\n第二行' } })
    fireEvent.keyDown(fu(), { key: 'Enter', shiftKey: true })
    expect(ctl.followup).not.toHaveBeenCalled()
    fireEvent.keyDown(fu(), { key: 'Enter' })
    expect(ctl.followup).toHaveBeenCalledWith('c1', '第一行\n第二行', 'all')
  })
})
