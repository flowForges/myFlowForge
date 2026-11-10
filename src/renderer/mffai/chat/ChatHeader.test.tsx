import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatHeader } from './ChatHeader'
import MffaiView from '../MffaiView'
import { route } from '../route'
import { resetSeq } from '../test/events'
import { installFakeForge } from '../test/fakeForge'
import { S, actBtn, memStorage, mountPanel, panelCalls } from '../test/panel'

let done: (() => void) | undefined
beforeEach(() => { resetSeq(); route.set({ page: 'chat', sessionId: S }); vi.stubGlobal('localStorage', memStorage()) })
afterEach(() => { done?.(); done = undefined; vi.unstubAllGlobals() })

const head = () => document.querySelector('header.mffai-chathead') as HTMLElement

describe('ChatHeader', () => {
  it('title, 运行中, cwd, mode, then the 活动 toggle with the count; aria-pressed / aria-expanded follow panelOn', () => {
    const onToggle = vi.fn()
    const { rerender } = render(<ChatHeader title="登录重构" running cwd="~/work/forge-api" mode="ask" pending={2} panelOn onToggle={onToggle} />)
    expect(head().querySelector('.mffai-chathead-title')!.textContent).toBe('登录重构')
    for (const t of ['运行中', '~/work/forge-api', '询问']) expect(within(head()).getByText(t)).toBeInTheDocument()
    const btn = within(head()).getByRole('button', { name: /活动/ })
    expect(btn.classList.contains('mffai-actbtn')).toBe(true)
    expect(btn.classList.contains('on')).toBe(true)
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    expect(btn.getAttribute('aria-expanded')).toBe('true')
    expect(btn.querySelector('.n')!.textContent).toBe('2')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
    // 收起时数字照样显示
    rerender(<ChatHeader title="登录重构" running={false} mode="auto" pending={2} panelOn={false} onToggle={onToggle} />)
    expect(btn.classList.contains('on')).toBe(false)
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.querySelector('.n')!.textContent).toBe('2')
    expect(within(head()).queryByText('运行中')).toBeNull()
    expect(within(head()).getByText('自动放行')).toBeInTheDocument()
    rerender(<ChatHeader title="登录重构" running={false} mode="ask" pending={0} panelOn={false} onToggle={onToggle} />)
    expect(btn.querySelector('.n')).toBeNull()
  })

  it('the toggle is a native button: keyboard reachable', () => {
    const onToggle = vi.fn()
    render(<ChatHeader title="t" running={false} mode="ask" pending={0} panelOn={false} onToggle={onToggle} />)
    const btn = within(head()).getByRole('button', { name: /活动/ })
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('type')).toBe('button')
    btn.focus()
    expect(document.activeElement).toBe(btn)
  })

  it('narrow: the mode chip carries the CSS-hidden class and stays in the DOM; wide: it does not', () => {
    const { rerender } = render(<ChatHeader title="t" running cwd="/w" mode="ask" pending={0} panelOn={false} narrow onToggle={() => {}} />)
    const mode = () => within(head()).getByText('询问').closest('.mffai-chathead-mode') as HTMLElement
    expect(mode().classList.contains('mffai-nhide')).toBe(true)
    expect(within(head()).getByText('运行中').closest('.mffai-nhide')).toBeNull()
    expect(within(head()).getByText('/w').closest('.mffai-nhide')).toBeNull()
    rerender(<ChatHeader title="t" running cwd="/w" mode="ask" pending={0} panelOn={false} onToggle={() => {}} />)
    expect(mode().classList.contains('mffai-nhide')).toBe(false)
  })

  it('in the pane: width 1199 → the mode chip hidden by class; 1200 → shown', async () => {
    const m = await mountPanel(1199); done = m.done
    const mode = () => within(head()).getByText('询问').closest('.mffai-chathead-mode') as HTMLElement
    expect(mode().classList.contains('mffai-nhide')).toBe(true)
    m.setWidth(1200)
    expect(mode().classList.contains('mffai-nhide')).toBe(false)
    expect(head().querySelector('.mffai-chathead-title')!.textContent).toBe('会话一')
    expect(within(head()).getByText('/repo')).toBeInTheDocument()
    expect(actBtn().querySelector('.n')!.textContent).toBe('1')
  })

  it('chat with a session open: the page header still shows every warning (Review Focus 11)', async () => {
    installFakeForge({
      state: { proxyStale: true },
      calls: {
        ...panelCalls(),
        status: {
          state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0',
          plugins: [{ id: 'mine', state: 'active', trust: 'dev' }], problems: ['dev_crashed'], dbUnprotected: true, secretsBackend: 'plaintext-file',
        },
        'memory.health': { dbBytes: 0, rawRows: 0, noteRows: 0, cursorLag: 0, pendingProposals: 0, problems: [] },
        'models.catalog': { presets: [], models: {} },
        'models.accounts': { accounts: [], secretsBackend: 'keychain' },
        'events.tail': { events: [] },
      },
    })
    render(<MffaiView />)
    await screen.findByText('fix the build')
    await waitFor(() => expect(head()).not.toBeNull())
    const page = document.querySelector('header.mffai-head')!
    for (const t of ['开发插件 · 完全访问', '开发插件已跳过', '数据库未收紧', '明文存储', '代理已改', '重启']) {
      await waitFor(() => expect(within(page as HTMLElement).getByText(t)).toBeInTheDocument())
    }
  })
})
