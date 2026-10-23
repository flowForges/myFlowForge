import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CouncilBlock, type CouncilControls } from './CouncilBlock'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ★css 在测试里被处理成空串,直接读源文件
const councilCss = readFileSync(join(__dirname, 'council.css'), 'utf8')
import type { ChatMessage, ProviderInfo } from '@shared/types'
import type { CouncilSeat, CouncilState, CouncilStatus, CouncilStage } from '@shared/council'

// B2:每一轮一行、每位席位一列;单元格全文可滚动、⤢ 放大、思考折叠、等待占位、全屏。

const mdRenders: string[] = []
vi.mock('../markdown', () => ({
  Markdown: ({ text }: { text: string }) => { mdRenders.push(text); return <div className="md">{text}</div> },
}))
beforeEach(() => { mdRenders.length = 0 })

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
    // ★配置顺序 B 在前:列序以配置为准,不是发言先后
    config: { topic: '议题', attachments: [], seats: [B, A], leader: L, mode: { kind: 'rounds', rounds: 3 } },
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
const controls = (): CouncilControls => ({ pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), followup: vi.fn(), choose: vi.fn(), interject: vi.fn() })
const el = (props: { messages: ChatMessage[]; st?: CouncilState; streaming?: string[] }) => (
  <CouncilBlock id="c1" messages={props.messages} state={props.st} streamingIds={new Set(props.streaming ?? [])} providers={providers} controls={controls()} />
)
const roundSec = (r: number) => document.querySelector(`.council-round-sec[data-round="${r}"]`) as HTMLElement

describe('CouncilBlock grid', () => {
  it('every round is a row with one column per seat in config order; leader summary full-width below the row', () => {
    render(el({
      messages: [
        topic, ai(A, 1, 'answer', '甲一'), ai(B, 1, 'answer', '乙一'), ai(L, 1, 'summary', '第一轮小结'),
        ai(A, 2, 'critique', '甲二'), ai(B, 2, 'critique', '乙二'), ai(L, 2, 'summary', '第二轮小结'),
      ],
      st: state('running', { round: 3 }),
    }))
    // ★所有轮次共用一个网格 / 一个横向滚动容器:列在各轮之间对齐、一起滚
    const grids = document.querySelectorAll('.council-grid')
    expect(grids).toHaveLength(1)
    expect((grids[0] as HTMLElement).style.gridTemplateColumns).toBe('repeat(2, minmax(260px, 1fr))')
    expect(grids[0].parentElement!.className).toContain('council-grid-scroll')
    for (const r of [1, 2]) {
      const cols = Array.from(roundSec(r).querySelectorAll(':scope > .council-col'))
      expect(cols.map(c => c.getAttribute('data-seat'))).toEqual([B.id, A.id])
      const leader = roundSec(r).querySelector('.council-leader-card') as HTMLElement
      expect(leader.textContent).toContain('👑')
      expect(leader.textContent).toContain(r === 1 ? '第一轮小结' : '第二轮小结')
      expect(leader.parentElement!.className).toContain('council-span')
      expect(cols.at(-1)!.compareDocumentPosition(leader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    expect(roundSec(2).querySelector(`.council-col[data-seat="${A.id}"]`)!.textContent).toContain('甲二')
  })

  it('a dropped seat keeps its column position in later rounds with a muted — cell', () => {
    render(el({
      messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'failed', ''), ai(B, 2, 'failed', ''), ai(A, 2, 'critique', 'a2'), ai(A, 3, 'critique', 'a3')],
      st: state('running', { round: 3, dropped: [B.id] }),
    }))
    for (const r of [1, 2, 3]) {
      const cols = Array.from(roundSec(r).querySelectorAll(':scope > .council-col'))
      expect(cols.map(c => c.getAttribute('data-seat'))).toEqual([B.id, A.id])
    }
    expect(roundSec(1).querySelector(`.council-col[data-seat="${B.id}"] .council-failed`)).not.toBeNull()
    const empty = roundSec(3).querySelector(`.council-col[data-seat="${B.id}"] .council-cell.empty`)!
    expect(empty.textContent).toBe('—')
    expect(roundSec(3).querySelector('.council-cell.waiting')).toBeNull()
  })

  it('consensus: votes render below the draft they vote on, seat-aligned', () => {
    render(el({
      messages: [
        topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'),
        ai(L, 1, 'consensus-draft', '草稿一'),
        ai(B, 1, 'consensus-vote', '同意'), ai(A, 1, 'consensus-vote', '不同意,风险'),
      ],
      st: state('running', { totalRounds: null, round: 2, config: { ...state('running').config, mode: { kind: 'consensus', maxRounds: 5, maxMinutes: 30 } } }),
    }))
    const sec = roundSec(1)
    const draft = sec.querySelector('.council-leader-card[data-stage="consensus-draft"]')!
    const answer = sec.querySelector('.council-cell[data-stage="answer"]')!
    const votes = Array.from(sec.querySelectorAll('.council-cell[data-stage="consensus-vote"]'))
    expect(votes.map(v => v.getAttribute('data-seat'))).toEqual([B.id, A.id])
    expect(answer.compareDocumentPosition(draft) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const v of votes) expect(draft.compareDocumentPosition(v) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(votes[0].querySelector('.council-vote')!.getAttribute('data-vote')).toBe('agree')
  })

  it('cells show the full text (no clamp) in a scrollable body', () => {
    const long = '很长的回答。'.repeat(400)
    render(el({ messages: [topic, ai(A, 1, 'answer', long), ai(B, 1, 'answer', '乙')], st: state('running') }))
    const body = document.querySelector(`.council-cell[data-seat="${A.id}"] .council-cell-body`)!
    expect(body.textContent).toContain(long)
    expect(document.querySelector('.council-cell.open, .council-more[aria-expanded]')).toBeNull()
  })

  it('⤢ opens a focus overlay with that utterance; Esc and a click outside close it', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', '甲的全文'), ai(B, 1, 'answer', '乙的全文')], st: state('running') }))
    const zoom = document.querySelector(`.council-cell[data-seat="${A.id}"] .council-zoom`) as HTMLButtonElement
    fireEvent.click(zoom)
    const dlg = screen.getByRole('dialog')
    expect(dlg.textContent).toContain('甲的全文')
    expect(dlg.textContent).not.toContain('乙的全文')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(zoom)
    fireEvent.mouseDown(document.querySelector('.council-focus-backdrop')!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('thinking: collapsed 「思考」 with elapsed when done; open while streaming, and the streaming cell is accented', () => {
    const done = ai(A, 1, 'answer', '甲', { think: { label: '已思考', steps: ['想了想'], elapsed: 7 } })
    const live = ai(B, 1, 'answer', '乙半句', { think: { label: '主代理思考中…', steps: ['正在想'] } })
    render(el({ messages: [topic, done, live], st: state('running', { speaking: [B.id] }), streaming: [live.id] }))
    const doneCell = document.querySelector(`.council-cell[data-seat="${A.id}"]`)!
    const doneThink = doneCell.querySelector('.think')!
    expect(doneThink.querySelector('.label')!.textContent).toBe('思考')
    expect(doneThink.querySelector('.t')!.textContent).toBe('7s')
    expect(doneThink.className).not.toContain('open')
    const liveCell = document.querySelector(`.council-cell[data-seat="${B.id}"]`)!
    expect(liveCell.className).toContain('live')
    expect(liveCell.querySelector('.think')!.className).toContain('open')
    expect(doneCell.className).not.toContain('live')
  })

  it('leader card has its own 思考 section', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'), ai(L, 1, 'summary', '小结', { think: { label: '已思考', steps: ['归纳'] } })], st: state('running', { round: 2 }) }))
    expect(document.querySelector('.council-leader-card .think .label')!.textContent).toBe('思考')
  })

  it('seats not yet heard from in the current round get a dashed placeholder with the seat name', () => {
    const live = ai(A, 2, 'critique', '甲在写')
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'), live], st: state('running', { round: 2, speaking: [A.id, B.id] }), streaming: [live.id] }))
    const waiting = roundSec(2).querySelector(`.council-cell.waiting[data-seat="${B.id}"]`)!
    expect(waiting.textContent).toContain(B.label)
    expect(roundSec(2).querySelector(`.council-cell.waiting[data-seat="${A.id}"]`)).toBeNull()
    expect(roundSec(1).querySelector('.council-cell.waiting')).toBeNull()
  })

  it('a fresh round with no speech yet already shows its placeholders', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'), ai(L, 1, 'summary', 's')], st: state('running', { round: 2 }) }))
    expect(roundSec(2).querySelectorAll('.council-cell.waiting')).toHaveLength(2)
  })

  it('no placeholders during a round break', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'), ai(L, 1, 'summary', 's')], st: state('paused', { round: 2, waitingForUser: true }) }))
    expect(document.querySelector('.council-cell.waiting')).toBeNull()
  })

  it('a seat dropped after two failures gets no placeholder', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'failed', ''), ai(B, 2, 'failed', ''), ai(A, 2, 'critique', 'a2')], st: state('running', { round: 3, dropped: [B.id] }) }))
    expect(roundSec(3).querySelector(`.council-cell.waiting[data-seat="${B.id}"]`)).toBeNull()
    expect(roundSec(3).querySelector(`.council-cell.waiting[data-seat="${A.id}"]`)).not.toBeNull()
  })

  it('an interjection is a full-width user row in the round it belongs to', () => {
    const inter: ChatMessage = { id: 'c1:interject:1', who: 'user', text: '补充一句', ts: '2026-10-21T10:02:00Z', council: { id: 'c1', round: 2, stage: 'interject' } }
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a'), ai(B, 1, 'answer', 'b'), inter, ai(A, 2, 'critique', 'a2')], st: state('running', { round: 2 }) }))
    const row = roundSec(2).querySelector('.council-interject') as HTMLElement
    expect(row.textContent).toContain('补充一句')
    expect(row.closest('.council-span')).not.toBeNull()   // 整行宽,不在某一列里
    expect(row.closest('.council-col')).toBeNull()
    expect(roundSec(1).querySelector('.council-interject')).toBeNull()
  })

  it('header ⤢ 全屏 puts the block in a full-window overlay; Esc leaves it', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a')], st: state('running') }))
    fireEvent.click(screen.getByRole('button', { name: '全屏' }))
    expect(document.querySelector('.council-block')!.className).toContain('fullscreen')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.council-block')!.className).not.toContain('fullscreen')
  })

  it('focus overlay takes focus and gives it back to the ⤢ button on close', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', '甲'), ai(B, 1, 'answer', '乙')], st: state('running') }))
    const zoom = document.querySelector(`.council-cell[data-seat="${A.id}"] .council-zoom`) as HTMLButtonElement
    zoom.focus()
    fireEvent.click(zoom)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(zoom)
  })

  it('header click in fullscreen exits fullscreen instead of collapsing the block', () => {
    render(el({ messages: [topic, ai(A, 1, 'answer', 'a')], st: state('running') }))
    fireEvent.click(screen.getByRole('button', { name: '全屏' }))
    fireEvent.click(document.querySelector('.council-head')!)
    const block = document.querySelector('.council-block')!
    expect(block.className).not.toContain('fullscreen')
    expect(block.className).toContain('open')
  })

  it('fullscreen block and focus overlay opt out of the titlebar drag region (needs a real-app check too)', () => {
    const rule = (sel: string) => new RegExp(sel.replace(/\./g, '\\.') + '[^{]*\\{[^}]*-webkit-app-region:\\s*no-drag')
    expect(councilCss).toMatch(rule('.council-block.fullscreen'))
    expect(councilCss).toMatch(rule('.council-focus-backdrop'))
  })

  it('a delta in one cell does not re-render the other cells', () => {
    const a = ai(A, 1, 'answer', '甲稳定')
    const b1 = ai(B, 1, 'answer', '乙一')
    const st = state('running', { speaking: [B.id] })
    const { rerender } = render(el({ messages: [topic, a, b1], st, streaming: [b1.id] }))
    mdRenders.length = 0
    rerender(el({ messages: [topic, a, { ...b1, text: '乙一二' }], st, streaming: [b1.id] }))
    expect(mdRenders).toContain('乙一二')
    expect(mdRenders).not.toContain('甲稳定')
  })
})

describe('⤢ 放大弹窗:长输出能滚动', () => {
  it('★弹窗高度按视口封顶(百分比在 place-items:center 的 grid 里不生效),正文区自己滚', () => {
    const rule = councilCss.match(/\.council-focus\s*\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toMatch(/max-height:\s*calc\(100vh/)
    expect(rule).not.toMatch(/max-height:\s*100%/)
    const body = councilCss.match(/\.council-focus-body\s*\{[^}]*\}/)?.[0] ?? ''
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow:\s*auto/)
  })
})
