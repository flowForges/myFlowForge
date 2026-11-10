// 活动面板(08b §4.3、§4.4,Review Focus 4、9):主区宽度用 test/resize 的桩给,偏好存内存 localStorage。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { route } from '../route'
import { ACTIVITY_KEY } from '../layout'
import { resetSeq } from '../test/events'
import { S, act$, actBtn, body$, memStorage, mountPanel, panelCalls, panelEvents } from '../test/panel'

let done: (() => void) | undefined
beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }); vi.stubGlobal('localStorage', memStorage()) })
afterEach(() => { done?.(); done = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView })

const approval = () => document.querySelectorAll('[data-approval="a1"]')
const run = (id = 'r1') => document.querySelectorAll(`[data-run="${id}"]`)
const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('activity panel at main width 1440', () => {
  it('no stored value → docked panel; nothing is written until the user clicks', async () => {
    const set = vi.spyOn(localStorage, 'setItem')
    const m = await mountPanel(1440); done = m.done
    expect(act$()).not.toBeNull()
    expect(act$()!.classList.contains('drawer')).toBe(false)
    expect(document.querySelector('.mffai-scrim')).toBeNull()
    expect(localStorage.getItem(ACTIVITY_KEY)).toBeNull()
    expect(set).not.toHaveBeenCalled()
  })

  it('panel open: each card exactly once, inside the panel; the conversation holds an anchor where each card was', async () => {
    const m = await mountPanel(1440); done = m.done
    await waitFor(() => expect(within(act$()!).queryByRole('button', { name: '停止' })).not.toBeNull())
    expect(approval()).toHaveLength(1)
    expect(run()).toHaveLength(1)
    expect(act$()!.contains(approval()[0])).toBe(true)
    expect(act$()!.contains(run()[0])).toBe(true)
    expect(body$().querySelector('[data-approval], [data-run]')).toBeNull()
    await waitFor(() => expect(body$().querySelectorAll('button.mffai-anchor')).toHaveLength(3))
    const anchors = [...body$().querySelectorAll('button.mffai-anchor')]
    // r1(运行中)、a1(待批)在 t1 的尾巴之后按 seq;旧轮 t0 的 r0 结束了但还有没合并的改动
    expect(anchors.map((a) => a.textContent)).toEqual(['claude 未合并', 'codex 运行中', 'shell 待审批'])
    expect(anchors.map((a) => a.classList.contains('warn'))).toEqual([false, false, true])
    const tail1 = body$().querySelector('.mffai-tail[data-turn="t1"]')!
    expect(before(tail1, anchors[1])).toBe(true)
    expect(before(anchors[1], anchors[2])).toBe(true)
    expect(before(body$().querySelector('.mffai-tail[data-turn="t0"]')!, anchors[0])).toBe(true)
    expect(before(anchors[0], body$().querySelector('.mffai-tail[data-turn="t1"]')!)).toBe(true)
  })

  it('click 活动 → closed is stored, cards go back inline after their turn tail in seq order, anchors gone; again → open', async () => {
    const m = await mountPanel(1440); done = m.done
    expect(actBtn().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(actBtn())
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe('closed')
    expect(act$()).toBeNull()
    expect(actBtn().getAttribute('aria-expanded')).toBe('false')
    expect(body$().querySelector('.mffai-anchor')).toBeNull()
    await waitFor(() => expect(run('r0')).toHaveLength(1))
    const tail1 = body$().querySelector('.mffai-tail[data-turn="t1"]')!
    const [r1, a1] = [run()[0], approval()[0]]
    expect(body$().contains(r1) && body$().contains(a1)).toBe(true)
    expect(before(tail1, r1)).toBe(true)
    expect(before(r1, a1)).toBe(true)
    expect(before(body$().querySelector('.mffai-tail[data-turn="t0"]')!, run('r0')[0])).toBe(true)
    expect(before(run('r0')[0], tail1)).toBe(true)
    fireEvent.click(actBtn())
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe('open')
    expect(act$()).not.toBeNull()
  })

  it('a stored closed starts collapsed', async () => {
    localStorage.setItem(ACTIVITY_KEY, 'closed')
    const m = await mountPanel(1440); done = m.done
    expect(act$()).toBeNull()
    expect(approval()).toHaveLength(1)
    expect(body$().contains(approval()[0])).toBe(true)
  })

  it('› collapses the docked panel and stores closed', async () => {
    const m = await mountPanel(1440); done = m.done
    fireEvent.click(within(act$()!).getByRole('button', { name: '收起' }))
    expect(act$()).toBeNull()
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe('closed')
  })

  it('width 1279 → inline without writing the preference; 1300 → the panel is back; no ResizeObserver → inline', async () => {
    const set = vi.spyOn(localStorage, 'setItem')
    const m = await mountPanel(1440); done = m.done
    expect(act$()).not.toBeNull()
    m.setWidth(1279)
    expect(act$()).toBeNull()
    expect(body$().contains(approval()[0])).toBe(true)
    expect(body$().querySelector('.mffai-anchor')).toBeNull()
    expect(set).not.toHaveBeenCalled()
    m.setWidth(1300)
    expect(act$()).not.toBeNull()
    expect(act$()!.contains(approval()[0])).toBe(true)
    expect(set).not.toHaveBeenCalled()
  })

  it('width undefined (no stub) → inline', async () => {
    await mountPanel(undefined)
    expect(act$()).toBeNull()
    expect(body$().contains(approval()[0])).toBe(true)
    expect(body$().querySelector('.mffai-anchor')).toBeNull()
  })

  it('at 1100 活动 opens a drawer with a scrim, preference untouched; Esc, the scrim and › close it; at 1440 the drawer is gone', async () => {
    const set = vi.spyOn(localStorage, 'setItem')
    const m = await mountPanel(1100); done = m.done
    expect(act$()).toBeNull()
    const open = () => { fireEvent.click(actBtn()); expect(act$()!.classList.contains('drawer')).toBe(true); expect(document.querySelector('.mffai-scrim')).not.toBeNull() }
    open()
    expect(actBtn().getAttribute('aria-expanded')).toBe('true')
    expect(act$()!.contains(approval()[0])).toBe(true)
    expect(body$().querySelector('.mffai-anchor')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(act$()).toBeNull()
    expect(document.querySelector('.mffai-scrim')).toBeNull()
    open()
    fireEvent.click(document.querySelector('.mffai-scrim')!)
    expect(act$()).toBeNull()
    open()
    fireEvent.click(within(act$()!).getByRole('button', { name: '收起' }))
    expect(act$()).toBeNull()
    open()
    expect(set).not.toHaveBeenCalled()
    m.setWidth(1440)
    expect(document.querySelector('.mffai-act.drawer')).toBeNull()
    expect(document.querySelector('.mffai-scrim')).toBeNull()
    expect(act$()).not.toBeNull()
    // 偏好设成收起后:宽窗下停靠面板跟偏好走,窄窗抽屉的状态清掉了
    fireEvent.click(actBtn())
    expect(act$()).toBeNull()
    m.setWidth(1100)
    expect(act$()).toBeNull()
  })

  it('the 活动 button shows the pending-approval count in both states', async () => {
    const m = await mountPanel(1440); done = m.done
    expect(actBtn().querySelector('.n')!.textContent).toBe('1')
    fireEvent.click(actBtn())
    expect(actBtn().querySelector('.n')!.textContent).toBe('1')
    expect(within(actBtn()).getByText('活动')).toBeInTheDocument()
  })

  it('the preference is global: another session keeps it', async () => {
    const calls = panelCalls()
    const ev2 = panelEvents('s2')
    calls['session.state'] = ((p: { sessionId: string }) => p.sessionId === S
      ? (panelCalls()['session.state'] as object)
      : { session: { ...(panelCalls()['session.state'] as { session: object }).session, id: 's2' }, events: ev2, hasMore: false, lastSeq: ev2.at(-1)!.seq, open: { turnId: 't1', parked: false, approvalIds: ['a1'] } }) as never
    const m = await mountPanel(1440, calls); done = m.done
    fireEvent.click(actBtn())
    expect(act$()).toBeNull()
    act(() => route.set({ page: 'chat', sessionId: 's2' }))
    await waitFor(() => expect(screen.getAllByText('fix the build')).toHaveLength(1))
    await waitFor(() => expect(document.querySelector('[data-approval="a1"]')).not.toBeNull())
    expect(act$()).toBeNull()
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe('closed')
  })

  it('route.runId for a run in an older turn → the panel switches to 会话 and scrolls #mffai-run-<id> into view', async () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const m = await mountPanel(1440); done = m.done
    const seg = within(act$()!).getByRole('group', { name: '范围' })
    expect(within(seg).getByRole('button', { name: '本轮' }).getAttribute('aria-pressed')).toBe('true')
    expect(run('r0')).toHaveLength(0)
    act(() => route.set({ page: 'chat', sessionId: S, runId: 'r0' }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(within(seg).getByRole('button', { name: '会话' }).getAttribute('aria-pressed')).toBe('true')
    const el = document.getElementById('mffai-run-r0')!
    expect(act$()!.contains(el)).toBe(true)
    expect(spy.mock.contexts[0]).toBe(el)
  })

  it('本轮: sections 待你处理 / 委派运行 / 本轮改动 N (jumps to the turn tail); 会话: 审批 / 委派运行 over every turn', async () => {
    const evs = panelEvents()
    const i = evs.findIndex((x) => x.type === 'turn.snapshot')
    const snapEnd = { ...evs[i], payload: { turnId: 't1', phase: 'end', ref: 'refs/end', changed: 4 } }
    const withSnap = [...evs.slice(0, i + 1), snapEnd, ...evs.slice(i + 1)].map((x, k) => ({ ...x, seq: k + 1 }))
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const m = await mountPanel(1440, panelCalls(withSnap)); done = m.done
    const heads = () => [...act$()!.querySelectorAll('.mffai-act-sec > .mffai-act-h')].map((h) => h.textContent)
    expect(heads()).toEqual(['待你处理 1', '委派运行 1', '本轮改动 4'])
    expect(within(act$()!).getByText('待处理 1')).toBeInTheDocument()
    fireEvent.click(within(act$()!).getByRole('button', { name: '本轮改动 4' }))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.contexts[0]).toBe(body$().querySelector('.mffai-tail[data-turn="t1"]'))
    fireEvent.click(within(act$()!).getByRole('button', { name: '会话' }))
    expect(heads()).toEqual(['审批 1', '委派运行 2'])
    expect(run('r0')).toHaveLength(1)
    expect(act$()!.contains(run('r0')[0])).toBe(true)
    expect(approval()).toHaveLength(1)
  })

  it('an anchor opens the card: a run in an older turn switches to 会话 and scrolls to it', async () => {
    const spy = vi.fn()
    Element.prototype.scrollIntoView = spy
    const m = await mountPanel(1440); done = m.done
    fireEvent.click(await within(body$()).findByRole('button', { name: 'claude 未合并' }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.contexts.at(-1)).toBe(document.getElementById('mffai-run-r0'))
    expect(act$()!.contains(document.getElementById('mffai-run-r0'))).toBe(true)
  })
})

describe('drawer focus, anchors focus the card, anchor labels escaped (Task 5 review 2, 5, 6)', () => {
  it('keyboard: 活动 opens the drawer and focus moves into it; the conversation is inert; Esc closes it and focus returns to 活动', async () => {
    const m = await mountPanel(1100); done = m.done
    const convo = document.querySelector('.mffai-convo') as HTMLElement
    actBtn().focus()
    expect(document.activeElement).toBe(actBtn())
    fireEvent.click(actBtn())
    expect(act$()!.classList.contains('drawer')).toBe(true)
    expect(act$()!.contains(document.activeElement)).toBe(true)
    expect(convo.hasAttribute('inert')).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(act$()).toBeNull()
    expect(convo.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(actBtn())
    // 遮罩和 › 关也把焦点还给 活动
    fireEvent.click(actBtn())
    fireEvent.click(within(act$()!).getByRole('button', { name: '收起' }))
    expect(document.activeElement).toBe(actBtn())
    fireEvent.click(actBtn())
    fireEvent.click(document.querySelector('.mffai-scrim')!)
    expect(document.activeElement).toBe(actBtn())
    expect(convo.hasAttribute('inert')).toBe(false)
  })

  it('docked: the conversation is never inert', async () => {
    const m = await mountPanel(1440); done = m.done
    expect(act$()).not.toBeNull()
    expect(document.querySelector('.mffai-convo')!.hasAttribute('inert')).toBe(false)
  })

  it('an anchor click moves focus to the card: its first enabled button', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const m = await mountPanel(1440); done = m.done
    fireEvent.click(within(body$()).getByRole('button', { name: 'shell 待审批' }))
    await waitFor(() => expect(document.activeElement).toBe(within(approval()[0] as HTMLElement).getByRole('button', { name: '允许' })))
  })

  it('an anchor to a card with no enabled button focuses the card itself (tabIndex -1)', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    const evs = panelEvents().filter((x) => x.type !== 'approval.requested')
    const m = await mountPanel(1440, { ...panelCalls(evs), 'executor.runs': { runs: [] } }); done = m.done
    const stop = within(run()[0] as HTMLElement).getByRole('button', { name: '停止' }) as HTMLButtonElement
    stop.disabled = true
    fireEvent.click(within(body$()).getByRole('button', { name: 'codex 运行中' }))
    await waitFor(() => expect(document.activeElement).toBe(run()[0]))
    expect((run()[0] as HTMLElement).tabIndex).toBe(-1)
  })

  it('anchor labels show invisible characters in a tool or executor name as escapes', async () => {
    const evs = panelEvents().map((x) => x.type === 'approval.requested'
      ? { ...x, payload: { ...(x.payload as object), tool: 'sh\u202Eell' } } : x)
    const m = await mountPanel(1440, panelCalls(evs)); done = m.done
    const a = body$().querySelector('.mffai-anchor.warn')!
    expect(a.querySelector('.mffai-esc')).not.toBeNull()
    expect(a.textContent).toBe('sh\\u{202E}ell 待审批')
    expect(a.innerHTML).not.toMatch(/\u202E/)
  })
})

describe('untrusted content inside the panel (Review Focus 9)', () => {
  it('an approval summary and a run progress text of an <img> tag render as text; an invisible character renders as .mffai-esc', async () => {
    const tag = '<img src=x onerror=alert(1)>'
    const m = await mountPanel(1440, panelCalls(panelEvents(S, { summary: `${tag}‮`, progress: tag }))); done = m.done
    const panel = act$()!
    expect(panel.querySelector('img')).toBeNull()
    expect(panel.querySelector('pre.mffai-summary')!.textContent).toBe(`${tag}\\u{202E}`)
    expect(panel.querySelector('pre.mffai-summary .mffai-esc')).not.toBeNull()
    expect(panel.querySelector('.mffai-progress-text')!.textContent).toBe(tag)
  })
})
