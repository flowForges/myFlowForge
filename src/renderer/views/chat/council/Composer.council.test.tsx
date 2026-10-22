import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Composer } from '../Composer'
import type { ProviderInfo } from '@shared/types'
import type { CouncilState, CouncilStatus } from '@shared/council'
import type { CouncilApi } from '../../../state/useCouncil'
import { flashToast } from '../../../components/flashToast'

vi.mock('../../../components/flashToast', () => ({ flashToast: vi.fn() }))

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus', label: 'Opus' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'GPT-6' }] },
]

beforeEach(() => { (window as any).forge = { openFiles: vi.fn(async () => []) }; vi.mocked(flashToast).mockClear() })

function councilApi(status?: CouncilStatus, over: Partial<CouncilState> = {}): CouncilApi {
  const active = status ? ({ id: 'c1', status, ...over } as CouncilState) : undefined
  return {
    states: active ? [active] : [], active, lastConfig: null,
    start: vi.fn(async () => {}), pause: vi.fn(), resume: vi.fn(), stop: vi.fn(),
    interject: vi.fn(), followup: vi.fn(), choose: vi.fn(),
    projects: vi.fn(async () => []),
  }
}

const sel = { agentId: 'claude', modelId: 'opus', permissionMode: 'auto' as const, browserUse: 'off' as const }
function renderComposer(council: CouncilApi, onSend = vi.fn(), busy = false, lockedReason?: string) {
  const r = render(<Composer providers={providers} disabled={false} busy={busy} lockedReason={lockedReason} onSend={onSend} selection={sel} onSelectionChange={() => {}} council={council} />)
  return { ...r, onSend, ta: r.container.querySelector('textarea')! }
}
const panel = () => document.querySelector('.council-setup:not([hidden])')
const toggle = () => screen.getByRole('button', { name: 'AI 共商' })

function addSeat(provider: string, model: string) {
  fireEvent.click(screen.getByRole('button', { name: '添加讨论方' }))
  fireEvent.click(document.querySelector(`.council-add [data-cprov="${provider}"]`)!)
  fireEvent.click(document.querySelector(`.council-add [data-cmodel="${model}"]`)!)
}

describe('Composer · AI 共商', () => {
  it('no council prop → no button', () => {
    render(<Composer providers={providers} disabled={false} onSend={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'AI 共商' })).toBeNull()
  })

  it('panel is absent until the button is clicked; clicking again closes it', () => {
    renderComposer(councilApi())
    expect(panel()).toBeNull()
    fireEvent.click(toggle())
    expect(panel()).toBeTruthy()
    fireEvent.click(toggle())
    expect(panel()).toBeNull()
  })

  it('start uses composer text as topic + attachments, seats in displayed order; then clears and closes', async () => {
    const council = councilApi()
    const { ta } = renderComposer(council)
    fireEvent.change(ta, { target: { value: '  用哪种缓存?  ' } })
    fireEvent.click(toggle())
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    fireEvent.click(screen.getByRole('button', { name: /开始讨论/ }))
    await waitFor(() => expect(council.start).toHaveBeenCalled())
    const cfg = (council.start as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(cfg.topic).toBe('用哪种缓存?')
    expect(cfg.attachments).toEqual([])
    expect(cfg.seats.map((s: { id: string }) => s.id)).toEqual(['codex:gpt-6', 'claude:opus'])
    await waitFor(() => expect(panel()).toBeNull())
    expect(ta.value).toBe('')
  })

  it('with the panel open the send button becomes 开始讨论 and Enter starts; closing restores normal send', async () => {
    const council = councilApi()
    const { ta, onSend } = renderComposer(council)
    fireEvent.change(ta, { target: { value: '议题' } })
    fireEvent.click(toggle())
    // 面板里没有自己的开始按钮:唯一的「开始讨论」就是输入框的发送键
    expect(document.querySelector('.council-setup')!.textContent).not.toContain('开始讨论')
    const go = screen.getByRole('button', { name: '开始讨论' }) as HTMLButtonElement
    expect(go.id).toBe('sendBtn')
    expect(go.disabled).toBe(true)
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    expect(go.disabled).toBe(false)
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => expect(council.start).toHaveBeenCalledTimes(1))
    expect((council.start as ReturnType<typeof vi.fn>).mock.calls[0][0].topic).toBe('议题')
    expect(onSend).not.toHaveBeenCalled()
    await waitFor(() => expect(panel()).toBeNull())
    expect(screen.queryByRole('button', { name: '开始讨论' })).toBeNull()
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }))
  })

  it('Enter with the panel open and nothing startable does not send a chat message', () => {
    const council = councilApi()
    const { ta, onSend } = renderComposer(council)
    fireEvent.change(ta, { target: { value: '议题' } })
    fireEvent.click(toggle())
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    expect(council.start).not.toHaveBeenCalled()
  })

  it('start disabled while a workflow run is active/queued in this session (R13)', () => {
    const { ta } = renderComposer(councilApi(), vi.fn(), false, '工作流运行中')
    fireEvent.change(ta, { target: { value: 'topic' } })
    fireEvent.click(toggle())
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    expect((screen.getByRole('button', { name: /开始讨论/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('placeholder is 议题 while the setup panel is open, normal task placeholder when closed', () => {
    const { ta } = renderComposer(councilApi())
    const normal = ta.getAttribute('placeholder')
    expect(normal).not.toBe('议题')
    fireEvent.click(toggle())
    expect(ta.getAttribute('placeholder')).toBe('议题')
    fireEvent.click(toggle())
    expect(ta.getAttribute('placeholder')).toBe(normal)
  })

  it('closing and reopening the panel keeps the picked seats', () => {
    renderComposer(councilApi())
    fireEvent.click(toggle())
    addSeat('codex', 'gpt-6')
    fireEvent.click(toggle())
    expect(panel()).toBeNull()
    fireEvent.click(toggle())
    expect(Array.from(document.querySelectorAll('.council-seat')).map(e => e.getAttribute('data-seat'))).toEqual(['codex:gpt-6'])
  })

  it('start failure → toast with mapped message, panel stays open, text kept', async () => {
    const council = councilApi()
    ;(council.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Error invoking remote method 'council:start': Error: busy"))
    const { ta } = renderComposer(council)
    fireEvent.change(ta, { target: { value: 'topic' } })
    fireEvent.click(toggle())
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    fireEvent.click(screen.getByRole('button', { name: /开始讨论/ }))
    await waitFor(() => expect(flashToast).toHaveBeenCalledWith('当前会话正忙'))
    expect(panel()).toBeTruthy()
    expect(ta.value).toBe('topic')
    await waitFor(() => expect((screen.getByRole('button', { name: /开始讨论/ }) as HTMLButtonElement).disabled).toBe(false))
  })

  it('start button is disabled while start is pending (no double IPC)', async () => {
    const council = councilApi()
    let resolve!: () => void
    ;(council.start as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    const { ta } = renderComposer(council)
    fireEvent.change(ta, { target: { value: 'topic' } })
    fireEvent.click(toggle())
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    const btn = screen.getByRole('button', { name: /开始讨论/ }) as HTMLButtonElement
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(btn.disabled).toBe(true)
    expect(council.start).toHaveBeenCalledTimes(1)
    resolve()
    await waitFor(() => expect(panel()).toBeNull())
  })

  it('busy chat turn with the panel open: no 开始讨论, Enter queues the message normally', () => {
    const council = councilApi()
    const { ta, onSend } = renderComposer(council, vi.fn(), true)
    fireEvent.click(toggle())
    expect(panel()).toBeTruthy()
    expect(screen.queryByRole('button', { name: '开始讨论' })).toBeNull()
    fireEvent.change(ta, { target: { value: '排队这条' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: '排队这条' }))
    expect(council.start).not.toHaveBeenCalled()
  })

  it.each(['running', 'finalizing'] as const)('the AI 共商 toggle is disabled while a council is %s', (status) => {
    renderComposer(councilApi(status))
    expect((toggle() as HTMLButtonElement).disabled).toBe(true)
  })

  it.each([
    ['running', {}, '插话'],
    ['paused', { waitingForUser: true }, '补充'],
  ] as const)('panel open when a council turns %s → panel closes, toggle disabled, Enter interjects', (status, over, ph) => {
    const onSend = vi.fn()
    const idle = councilApi()
    const { ta, rerender } = renderComposer(idle, onSend)
    fireEvent.click(toggle())
    expect(panel()).toBeTruthy()
    const live = councilApi(status, over)
    rerender(<Composer providers={providers} disabled={false} busy={false} onSend={onSend} selection={sel} onSelectionChange={() => {}} council={live} />)
    expect(panel()).toBeNull()
    expect((toggle() as HTMLButtonElement).disabled).toBe(true)
    expect(ta.getAttribute('placeholder')).toBe(ph)
    fireEvent.change(ta, { target: { value: '补一句' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(live.interject).toHaveBeenCalledWith('c1', '补一句')
    expect(live.start).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('开始讨论 has the 回车 tooltip', () => {
    const { ta } = renderComposer(councilApi())
    fireEvent.change(ta, { target: { value: 't' } })
    fireEvent.click(toggle())
    expect(screen.getByRole('button', { name: '开始讨论' }).getAttribute('title')).toBe('开始讨论 (回车)')
  })

  it('a paused council does not block starting a new one (R9)', () => {
    const { ta } = renderComposer(councilApi('paused'))
    fireEvent.change(ta, { target: { value: 'topic' } })
    fireEvent.click(toggle())
    addSeat('codex', 'gpt-6')
    addSeat('claude', 'opus')
    expect((screen.getByRole('button', { name: /开始讨论/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('running council → Enter interjects instead of sending; placeholder 插话', () => {
    const council = councilApi('running')
    const { ta, onSend } = renderComposer(council)
    expect(ta.getAttribute('placeholder')).toBe('插话')
    fireEvent.change(ta, { target: { value: '别忘了成本' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(council.interject).toHaveBeenCalledWith('c1', '别忘了成本')
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe('')
  })

  it('paused council → Enter sends normally', () => {
    const council = councilApi('paused')
    const { ta, onSend } = renderComposer(council)
    expect(ta.getAttribute('placeholder')).not.toBe('插话')
    fireEvent.change(ta, { target: { value: 'hello' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }))
    expect(council.interject).not.toHaveBeenCalled()
  })

  it('round break (waitingForUser) → placeholder 补充, Enter interjects instead of sending', () => {
    const council = councilApi('paused', { waitingForUser: true })
    const { ta, onSend } = renderComposer(council)
    expect(ta.getAttribute('placeholder')).toBe('补充')
    fireEvent.change(ta, { target: { value: '再考虑下成本' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(council.interject).toHaveBeenCalledWith('c1', '再考虑下成本')
    expect(onSend).not.toHaveBeenCalled()
    expect(ta.value).toBe('')
  })

  it('finalizing council → input disabled', () => {
    const { ta } = renderComposer(councilApi('finalizing'))
    expect(ta.disabled).toBe(true)
  })
})
