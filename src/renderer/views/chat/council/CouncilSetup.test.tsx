import { describe, it, expect, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { CouncilSetup, SeatPicker, councilStartError, placeSeatMenu, type CouncilSetupHandle } from './CouncilSetup'
import type { ProviderInfo } from '@shared/types'
import type { CouncilLastConfig } from '../../../state/useCouncil'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'GPT-6' }] },
  { id: 'cursor', displayName: 'Cursor', installed: true, models: [{ id: 'auto', label: 'Auto' }] },
  { id: 'gemini', displayName: 'Gemini', installed: false, models: [{ id: 'pro', label: 'Pro' }] },
]

// ★面板自己没有「开始讨论」按钮(B4):由输入框的发送键经 handle.start() 触发,可否开始经 onCanStartChange 报上去
let ready = false
const onCanStartChange = (v: boolean) => { ready = v }
let handle = createRef<CouncilSetupHandle>()
const canStart = () => ready
const start = () => act(() => { handle.current!.start() })

function setup(over: Partial<React.ComponentProps<typeof CouncilSetup>> = {}) {
  const onStart = vi.fn()
  ready = false
  handle = createRef<CouncilSetupHandle>()
  const utils = render(
    <CouncilSetup
      ref={handle}
      onCanStartChange={onCanStartChange}
      providers={providers}
      lastConfig={null}
      projects={async () => []}
      topic="议题"
      attachments={[]}
      blocked={false}
      onStart={onStart}
      {...over}
    />,
  )
  return { onStart, ...utils }
}

function addSeat(provider: string, model: string) {
  fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
  fireEvent.click(document.querySelector(`.council-pop [data-cprov="${provider}"]`)!)
  fireEvent.click(document.querySelector(`.council-pop [data-cmodel="${model}"]`)!)
}

const seatIds = () => Array.from(document.querySelectorAll('.council-seat')).map(e => e.getAttribute('data-seat'))

describe('CouncilSetup', () => {
  it('provider picker lists only installed council-eligible CLIs (never cursor)', () => {
    setup()
    fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
    const ids = Array.from(document.querySelectorAll('.council-pop [data-cprov]')).map(e => e.getAttribute('data-cprov'))
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('start is disabled with 1 seat and enabled with 2 (leader defaults to the first seat)', () => {
    setup()
    addSeat('claude', 'opus')
    expect(canStart()).toBe(false)
    addSeat('codex', 'gpt-6')
    expect(canStart()).toBe(true)
  })

  it('the panel has no start button of its own; start() is a no-op while it cannot start', () => {
    const { onStart } = setup()
    expect(screen.queryByRole('button', { name: /开始讨论/ })).toBeNull()
    addSeat('claude', 'opus')
    start()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('a seated model is not offered again', () => {
    setup()
    addSeat('claude', 'opus')
    fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
    fireEvent.click(document.querySelector('.council-pop [data-cprov="claude"]')!)
    expect(document.querySelector('.council-pop [data-cmodel="opus"]')).toBeNull()
    expect(document.querySelector('.council-pop [data-cmodel="sonnet"]')).toBeTruthy()
  })

  it('start disabled when blocked or topic empty', () => {
    const { rerender, onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    const props = { providers, lastConfig: null, projects: async () => [], attachments: [], onStart, onCanStartChange, ref: handle }
    rerender(<CouncilSetup {...props} topic="议题" blocked={true} />)
    expect(canStart()).toBe(false)
    rerender(<CouncilSetup {...props} topic="  " blocked={false} />)
    expect(canStart()).toBe(false)
  })

  it('start passes seats in displayed order, labels, distinct leader id, mode', () => {
    const { onStart } = setup()
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    start()
    const cfg = onStart.mock.calls[0][0]
    expect(cfg.topic).toBe('议题')
    expect(cfg.seats.map((s: { id: string }) => s.id)).toEqual(['codex:gpt-6', 'claude:opus'])
    expect(cfg.seats[0].label).toBe('Codex · GPT-6')
    expect(cfg.leader).toMatchObject({ provider: 'codex', model: 'gpt-6' })
    expect(cfg.leader.id).not.toBe(cfg.seats[0].id)
    expect(cfg.mode).toEqual({ kind: 'rounds', rounds: 2 })
    expect(cfg.materials).toBeUndefined()
  })

  it('drag-and-drop reorders seats', () => {
    const { onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'sonnet')
    const chips = document.querySelectorAll('.council-seat')
    fireEvent.dragStart(chips[2])
    fireEvent.dragOver(chips[0])
    fireEvent.drop(chips[0])
    expect(seatIds()).toEqual(['claude:sonnet', 'claude:opus', 'codex:gpt-6'])
    start()
    expect(onStart.mock.calls[0][0].seats.map((s: { id: string }) => s.id)).toEqual(['claude:sonnet', 'claude:opus', 'codex:gpt-6'])
  })

  it('✕ removes a seat', () => {
    setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: '移除 Claude Code · Opus' }))
    expect(seatIds()).toEqual(['codex:gpt-6'])
  })

  it('leader picker sets a separate leader; consensus mode and rounds stepper', () => {
    const { onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: /👑/ }))
    fireEvent.click(document.querySelector('.council-pop [data-cprov="claude"]')!)
    fireEvent.click(document.querySelector('.council-pop [data-cmodel="opus"]')!)
    fireEvent.click(screen.getByRole('button', { name: '＋' }))
    start()
    expect(onStart.mock.calls[0][0].leader).toMatchObject({ id: 'leader:claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' })
    expect(onStart.mock.calls[0][0].mode).toEqual({ kind: 'rounds', rounds: 3 })
    fireEvent.click(screen.getByRole('button', { name: '讨论到共识' }))
    start()
    expect(onStart.mock.calls[1][0].mode).toEqual({ kind: 'consensus', maxRounds: 5, maxMinutes: 30 })
  })

  it('defaults come from lastConfig, dropping seats whose CLI is not available', () => {
    const last: CouncilLastConfig = {
      seats: [
        { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' },
        { id: 'gemini:pro', provider: 'gemini', model: 'pro', label: 'Gemini · Pro' },
        { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
      ],
      leader: { id: 'leader:claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
      mode: { kind: 'rounds', rounds: 4 },
    }
    const { onStart } = setup({ lastConfig: last })
    expect(seatIds()).toEqual(['codex:gpt-6', 'claude:opus'])
    start()
    expect(onStart.mock.calls[0][0].mode).toEqual({ kind: 'rounds', rounds: 4 })
    expect(onStart.mock.calls[0][0].leader.id).toBe('leader:claude:opus')
  })

  it('materials: single project auto-selected; range must be non-empty', async () => {
    const { onStart } = setup({ projects: async () => [{ name: 'app', cwd: '/ws/app' }] })
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: '＋ 附加代码改动' }))
    await waitFor(() => expect((document.querySelector('.council-project') as HTMLSelectElement).value).toBe('/ws/app'))
    fireEvent.click(screen.getByRole('button', { name: '提交区间' }))
    expect(canStart()).toBe(false)
    fireEvent.change(document.querySelector('.council-range')!, { target: { value: 'a..b' } })
    expect(canStart()).toBe(true)
    start()
    expect(onStart.mock.calls[0][0].materials).toEqual({ projectCwd: '/ws/app', diff: { range: 'a..b' } })
    fireEvent.click(screen.getByRole('button', { name: '文件' }))
    fireEvent.change(document.querySelector('.council-files')!, { target: { value: 'src/a.ts, src/b.ts ,' } })
    start()
    expect(onStart.mock.calls[1][0].materials).toEqual({ projectCwd: '/ws/app', files: ['src/a.ts', 'src/b.ts'] })
    fireEvent.click(screen.getByRole('button', { name: '未提交的改动' }))
    start()
    expect(onStart.mock.calls[2][0].materials).toEqual({ projectCwd: '/ws/app', diff: 'uncommitted' })
  })

  it('drops remembered seats whose model is gone; unusable leader falls back to the first seat', () => {
    const last: CouncilLastConfig = {
      seats: [
        { id: 'claude:old', provider: 'claude', model: 'old', label: 'Claude Code · Old' },
        { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' },
        { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
      ],
      leader: { id: 'leader:gemini:pro', provider: 'gemini', model: 'pro', label: 'Gemini · Pro' },
      mode: { kind: 'rounds', rounds: 2 },
    }
    const { onStart } = setup({ lastConfig: last })
    expect(seatIds()).toEqual(['codex:gpt-6', 'claude:opus'])
    start()
    expect(onStart.mock.calls[0][0].leader).toMatchObject({ id: 'leader:codex:gpt-6', provider: 'codex', model: 'gpt-6' })
  })

  it('「每轮结束后等我」 defaults on and is sent as pauseBetweenRounds; turning it off sends false', () => {
    const { onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    const wait = screen.getByRole('switch', { name: '每轮结束后等我' })
    expect(wait.getAttribute('aria-checked')).toBe('true')
    start()
    expect(onStart.mock.calls[0][0].pauseBetweenRounds).toBe(true)
    fireEvent.click(wait)
    expect(wait.getAttribute('aria-checked')).toBe('false')
    start()
    expect(onStart.mock.calls[1][0].pauseBetweenRounds).toBe(false)
  })

  it('「每轮结束后等我」 restores from lastConfig (missing = on)', () => {
    const seats = [
      { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' },
      { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
    ]
    const last: CouncilLastConfig = { seats, leader: { ...seats[1], id: 'leader:claude:opus' }, mode: { kind: 'rounds', rounds: 2 }, pauseBetweenRounds: false }
    const { unmount } = setup({ lastConfig: last })
    expect(screen.getByRole('switch', { name: '每轮结束后等我' }).getAttribute('aria-checked')).toBe('false')
    unmount()
    const { pauseBetweenRounds: _p, ...old } = last
    setup({ lastConfig: old })
    expect(screen.getByRole('switch', { name: '每轮结束后等我' }).getAttribute('aria-checked')).toBe('true')
  })

  it('councilStartError maps IPC error codes', () => {
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: busy"))).toBe('当前会话正忙')
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: provider-not-installed"))).toBe('配置无效')
    expect(councilStartError(new Error('seats-too-few'))).toBe('配置无效')
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: materials-invalid"))).toBe('参考材料无效')
    expect(councilStartError(new Error("Error invoking remote method 'council:start': Error: 工作区已归档，恢复后才能继续。"))).toBe('工作区已归档，恢复后才能继续。')
  })

  it('shows the estimate as an upper-bound minute count', () => {
    setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    // 2 seats, 2 rounds: turns = 1 + 1*2 + 2 + 1 = 6 → hi = 12
    expect(screen.getByText('约 12 分钟')).toBeTruthy()
  })

  it('consensus mode has no round cap, so no minute estimate is shown', () => {
    setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: '讨论到共识' }))
    expect(document.querySelector('.council-eta')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '按轮次' }))
    expect(document.querySelector('.council-eta')).not.toBeNull()
  })

  it('leader is its own row (amber label), not inside the seat grid, with a hover tooltip and no caption', () => {
    setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    const slot = document.querySelector('.council-leader-slot') as HTMLElement
    expect(slot).not.toBeNull()
    expect(slot.getAttribute('title')).toBe('领导者:每轮只做总结,不参与提方案;最后输出共识结果')
    expect(slot.closest('.council-seats')).toBeNull()
    const label = screen.getByText('👑 领导者')
    expect(label.classList.contains('council-label-leader')).toBe(true)
    expect(label.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(slot.textContent).toContain('Claude Code · Opus')
    expect(slot.textContent).not.toContain('总结')
  })

  it('rows are labelled 方式 / 讨论方 / 👑 领导者', () => {
    setup()
    for (const t of ['方式', '讨论方', '👑 领导者']) expect(screen.getByText(t).classList.contains('council-label')).toBe(true)
    expect(screen.getByText('轮')).toBeTruthy()
  })

  it('「每轮结束后等我」 is a switch that toggles pauseBetweenRounds', () => {
    const { onStart } = setup()
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    const sw = screen.getByRole('switch', { name: '每轮结束后等我' })
    expect(sw.classList.contains('on')).toBe(true)
    fireEvent.click(sw)
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(sw.classList.contains('on')).toBe(false)
    start()
    expect(onStart.mock.calls[0][0].pauseBetweenRounds).toBe(false)
    fireEvent.click(sw)
    start()
    expect(onStart.mock.calls[1][0].pauseBetweenRounds).toBe(true)
  })

  it('seat grid ends with a same-size 「＋ 添加」 cell, hidden at 10 seats; 10 seats can start', () => {
    const { onStart } = setup({ providers: [{ id: 'claude', displayName: 'Claude Code', installed: true, models: Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, label: `M${i}` })) }] })
    const grid = document.querySelector('.council-seats')!
    expect(grid.lastElementChild!.classList.contains('council-add')).toBe(true)
    expect(screen.getByRole('button', { name: '添加讨论方' }).textContent).toBe('＋ 添加')
    for (let i = 0; i < 9; i++) addSeat('claude', `m${i}`)
    expect(seatIds()).toHaveLength(9)
    expect(grid.lastElementChild!.classList.contains('council-add')).toBe(true)
    addSeat('claude', 'm9')
    expect(seatIds()).toHaveLength(10)
    expect(screen.queryByRole('button', { name: '添加讨论方' })).toBeNull()
    start()
    expect(onStart.mock.calls[0][0].seats).toHaveLength(10)
  })

  it('materials are hidden by default; 「＋ 附加代码改动」 expands them, ✕ collapses and clears them', async () => {
    const { onStart } = setup({ projects: async () => [{ name: 'app', cwd: '/ws/app' }, { name: 'web', cwd: '/ws/web' }] })
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    expect(document.querySelector('.council-project')).toBeNull()
    expect(screen.queryByText('未提交的改动')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '＋ 附加代码改动' }))
    const sel = document.querySelector('.council-project') as HTMLSelectElement
    expect(sel.options[0].textContent).toBe('选择项目')
    await waitFor(() => expect(sel.options).toHaveLength(3))
    fireEvent.change(sel, { target: { value: '/ws/web' } })
    fireEvent.click(screen.getByRole('button', { name: '未提交的改动' }))
    start()
    expect(onStart.mock.calls[0][0].materials).toEqual({ projectCwd: '/ws/web', diff: 'uncommitted' })
    fireEvent.click(screen.getByRole('button', { name: '移除代码改动' }))
    expect(document.querySelector('.council-project')).toBeNull()
    start()
    expect(onStart.mock.calls[1][0].materials).toBeUndefined()
    fireEvent.click(screen.getByRole('button', { name: '＋ 附加代码改动' }))
    expect((document.querySelector('.council-project') as HTMLSelectElement).value).toBe('')
  })

  it('a single project auto-selected while collapsed does not send materials', async () => {
    const { onStart } = setup({ projects: async () => [{ name: 'app', cwd: '/ws/app' }] })
    addSeat('claude', 'opus')
    addSeat('codex', 'gpt-6')
    fireEvent.click(screen.getByRole('button', { name: '＋ 附加代码改动' }))
    await waitFor(() => expect((document.querySelector('.council-project') as HTMLSelectElement).value).toBe('/ws/app'))
    fireEvent.click(screen.getByRole('button', { name: '移除代码改动' }))
    start()
    expect(onStart.mock.calls[0][0].materials).toBeUndefined()
  })

  it('materials start expanded when lastConfig has them', async () => {
    const seats = [
      { id: 'codex:gpt-6', provider: 'codex', model: 'gpt-6', label: 'Codex · GPT-6' },
      { id: 'claude:opus', provider: 'claude', model: 'opus', label: 'Claude Code · Opus' },
    ]
    const last: CouncilLastConfig = { seats, leader: { ...seats[1], id: 'leader:claude:opus' }, mode: { kind: 'rounds', rounds: 2 }, materials: { projectCwd: '/ws/app', diff: { range: 'a..b' } } }
    const { onStart } = setup({ lastConfig: last, projects: async () => [{ name: 'app', cwd: '/ws/app' }, { name: 'web', cwd: '/ws/web' }] })
    expect(document.querySelector('.council-project')).not.toBeNull()
    await waitFor(() => expect((document.querySelector('.council-project') as HTMLSelectElement).value).toBe('/ws/app'))
    expect((document.querySelector('.council-range') as HTMLInputElement).value).toBe('a..b')
    start()
    expect(onStart.mock.calls[0][0].materials).toEqual({ projectCwd: '/ws/app', diff: { range: 'a..b' } })
  })

  it('contains no hint text elements', () => {
    const { container } = setup({ projects: async () => [{ name: 'app', cwd: '/ws/app' }] })
    addSeat('claude', 'opus')
    expect(container.querySelector('.hint, [class*="hint"], small')).toBeNull()
  })
})

describe('placeSeatMenu', () => {
  const view = { width: 1200, height: 800 }
  const rect = (top: number, left = 100, h = 30, w = 120) => ({ top, bottom: top + h, left, right: left + w })
  const pop = (height: number, width = 240) => ({ width, height })
  const inside = (p: { top: number; left: number; maxHeight: number }, popH: number, v = view) => {
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.top + Math.min(popH, p.maxHeight)).toBeLessThanOrEqual(v.height - 8)
  }

  it('room below: opens downward at its natural size', () => {
    const p = placeSeatMenu(rect(100), pop(300), view)
    expect(p.top).toBe(136)
    expect(p.maxHeight).toBeGreaterThanOrEqual(300)
    inside(p, 300)
  })

  it('the reported case: anchor near the window bottom, long model list → opens upward, bottom edge above the anchor', () => {
    const anchor = rect(700)
    const p = placeSeatMenu(anchor, pop(1200), view)
    expect(p.maxHeight).toBe(440)
    expect(p.top + p.maxHeight).toBe(anchor.top - 6)
    inside(p, 1200)
  })

  it('a short list that fits below stays below even near the bottom', () => {
    const p = placeSeatMenu(rect(650), pop(90), view)
    expect(p.top).toBe(686)
  })

  it('not enough room on either side: takes the roomier side and scrolls inside', () => {
    const v = { width: 800, height: 300 }
    const up = placeSeatMenu(rect(200), pop(1000), v)
    expect(up.maxHeight).toBe(186)
    expect(up.top).toBe(8)
    inside(up, 1000, v)
    const down = placeSeatMenu(rect(50), pop(1000), v)
    expect(down.top).toBe(86)
    expect(down.maxHeight).toBe(206)
    inside(down, 1000, v)
  })

  it('tiny window / anchor scrolled out of view: still inside the window with a usable list', () => {
    const v = { width: 400, height: 200 }
    for (const top of [-500, 90, 180, 900]) {
      const p = placeSeatMenu(rect(top), pop(1000), v)
      expect(p.maxHeight).toBeGreaterThan(0)
      inside(p, 1000, v)
    }
    const h = { width: 400, height: 100 }
    const p = placeSeatMenu(rect(40), pop(1000), h)
    expect(p.maxHeight).toBe(84)
    inside(p, 1000, h)
  })

  it('right edge: aligns to the anchor right edge; narrow window clamps to the left edge', () => {
    expect(placeSeatMenu(rect(100, 1050, 30, 120), pop(100, 300), view).left).toBe(870)
    expect(placeSeatMenu(rect(100, 20, 30, 120), pop(100, 500), { width: 400, height: 800 }).left).toBe(8)
  })
})

describe('SeatPicker popover', () => {
  const many: ProviderInfo[] = [{
    id: 'qoder', displayName: 'Qoder', installed: true,
    models: Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}` })),
  }, { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'GPT-6' }] }]

  // jsdom 没有布局:量到的矩形和内容高度都是假的,这里只验证「量了什么、写到了哪」,真实布局没验证
  function mockLayout(anchorTop: number, contentH = 1200) {
    const spies = [
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return { top: anchorTop, bottom: anchorTop + 30, left: 100, right: 220, width: 120, height: 30, x: 100, y: anchorTop, toJSON() {} } as DOMRect
      }),
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentH),
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => 240),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => 0),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 0),
    ]
    return () => spies.forEach(s => s.mockRestore())
  }
  const pick = (over: Partial<React.ComponentProps<typeof SeatPicker>> = {}) => {
    const onPick = vi.fn()
    render(<div style={{ overflow: 'hidden' }} data-testid="clip"><SeatPicker className="council-add" label="添加讨论方" trigger="＋" providers={many} onPick={onPick} {...over} /></div>)
    fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
    return onPick
  }
  const popEl = () => document.querySelector('.council-pop') as HTMLElement

  it('renders outside every clipping ancestor, on body', () => {
    pick()
    expect(popEl().parentElement).toBe(document.body)
    expect(screen.getByTestId('clip').contains(popEl())).toBe(false)
  })

  it('anchor near the bottom: positioned above it, capped, every model is rendered and pickable', () => {
    const restore = mockLayout(window.innerHeight - 60)
    const onPick = pick()
    fireEvent.click(popEl().querySelector('[data-cprov="qoder"]')!)
    const top = window.innerHeight - 60
    expect(popEl().style.maxHeight).toBe('440px')
    expect(parseFloat(popEl().style.top)).toBe(top - 6 - 440)
    expect(popEl().style.visibility).toBe('')
    expect(popEl().querySelectorAll('[data-cmodel]')).toHaveLength(40)
    fireEvent.click(popEl().querySelector('[data-cmodel="m39"]')!)
    expect(onPick).toHaveBeenCalledWith(many[0], 'm39')
    expect(popEl()).toBeNull()
    restore()
  })

  it('remeasures on window resize, and on outside scroll, but not on its own scroll', () => {
    let top = 100
    const restoreBase = mockLayout(top)
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ top, bottom: top + 30, left: 100, right: 220, width: 120, height: 30, x: 100, y: top, toJSON() {} }) as DOMRect)
    pick()
    fireEvent.click(popEl().querySelector('[data-cprov="qoder"]')!)
    expect(parseFloat(popEl().style.top)).toBe(136)
    top = 200
    fireEvent.scroll(popEl())
    expect(parseFloat(popEl().style.top)).toBe(136)
    fireEvent.scroll(document.body)
    expect(parseFloat(popEl().style.top)).toBe(236)
    top = 50
    fireEvent(window, new Event('resize'))
    expect(parseFloat(popEl().style.top)).toBe(86)
    spy.mockRestore()
    restoreBase()
  })

  it('clicking inside the portal does not count as an outside click; clicking elsewhere closes it', () => {
    pick()
    fireEvent.mouseDown(popEl().querySelector('[data-cprov="qoder"]')!)
    expect(popEl()).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(popEl()).toBeNull()
  })

  it('back from the model list returns to the providers', () => {
    pick()
    fireEvent.click(popEl().querySelector('[data-cprov="qoder"]')!)
    fireEvent.click(popEl().querySelector('.council-back')!)
    expect(popEl().querySelector('[data-cprov="codex"]')).not.toBeNull()
  })
})
