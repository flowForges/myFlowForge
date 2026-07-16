import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, waitFor, act } from '@testing-library/react'
import { PetApp } from './PetApp'
import type { EngineEvent } from '@shared/types'

let listeners: ((e: EngineEvent) => void)[]
let queueListeners: ((e: any) => void)[]
let settingsCb: ((s: unknown) => void) | null
let petSetExpanded: ReturnType<typeof vi.fn>
let petSetIgnoreMouse: ReturnType<typeof vi.fn>
let petSetPosition: ReturnType<typeof vi.fn>
let petSetScale: ReturnType<typeof vi.fn>
let petResizeBegin: ReturnType<typeof vi.fn>
const emit = (e: EngineEvent) => listeners.forEach(l => l(e))
// These tests exercise the FULL-mode popup (workspace list, command queue, session picker), so pin the
// pet to 'full'. Simple mode has its own tests (PetSimplePanel / deriveSimpleKind).
const SETTINGS = (over: any = {}) => ({ pet: { skin: 'bot', corner: 'right', enabled: true, interactionMode: 'full', pos: { bottom: 24 }, notify: { confirm: true, input: true, done: false }, states: { idle: { anim: 'float', accent: 'none' }, working: { anim: 'spin-halo', accent: 'none' }, confirm: { anim: 'alert', accent: 'warn' }, input: { anim: 'tilt', accent: 'accent' }, done: { anim: 'pulse-ok', accent: 'ok' }, ...over } } })
// Same as SETTINGS but the simple (codex-style) interaction mode.
const SETTINGS_SIMPLE = () => { const s = SETTINGS(); s.pet.interactionMode = 'simple'; return s }

beforeEach(() => {
  listeners = []; queueListeners = []; settingsCb = null
  petSetExpanded = vi.fn(); petSetIgnoreMouse = vi.fn(); petSetPosition = vi.fn(); petSetScale = vi.fn(async () => 'up'); petResizeBegin = vi.fn(async () => {})
  ;(window as any).forge = {
    onEngineEvent: (cb: any) => { listeners.push(cb); return () => {} },
    onChatEvent: vi.fn(() => () => {}),
    onChatQueueEvent: (cb: any) => { queueListeners.push(cb); return () => {} },
    sendChat: vi.fn(async () => {}),
    chatCancelQueued: vi.fn(async () => {}),
    chatStop: vi.fn(async () => {}),
    sessionList: vi.fn(async () => ({ sessions: [{ id: 's-1', title: '新会话', mode: 'chat', createdAt: 0 }], activeSessionId: 's-1' })),
    sessionSwitch: vi.fn(async () => ({})),
    onSessionsChanged: vi.fn(() => () => {}),
    onSettingsChanged: (cb: any) => { settingsCb = cb; return () => {} },
    getSettings: async () => SETTINGS(),
    listWorkspaces: vi.fn(async () => []),
    petSetExpanded, petSetIgnoreMouse, petSetPosition, petSetScale, petResizeBegin,
    petGetBounds: vi.fn(async () => ({ bounds: { x: 1200, y: 600, width: 140, height: 120 }, workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    petFocusWorkspace: vi.fn(), resolve: vi.fn(), setSettings: vi.fn(async (s: any) => s),
    petContextMenu: vi.fn(async () => {})
  }
})

describe('PetApp theme sync', () => {
  it('mirrors the app appearance onto the pet document (light theme → not dark)', async () => {
    ;(window as any).forge.getSettings = async () => ({ ...SETTINGS(), appearance: { theme: 'light', accent: 'violet', vibrancy: false, glass: false, density: 'compact', fontSize: 'large' } })
    render(<PetApp />)
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'))
    expect(document.documentElement.getAttribute('data-accent')).toBe('violet')
    expect(document.documentElement.getAttribute('data-density')).toBe('compact')
  })

  it('defaults to the light theme when settings predate the appearance block', async () => {
    // SETTINGS() has no appearance — the pet must fall back to the light default (new-user default).
    render(<PetApp />)
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'))
  })

  it('re-applies the theme when settings change to dark', async () => {
    ;(window as any).forge.getSettings = async () => ({ ...SETTINGS(), appearance: { theme: 'light', accent: 'blue', vibrancy: false, glass: false, density: 'comfortable', fontSize: 'medium' } })
    render(<PetApp />)
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('light'))
    act(() => settingsCb?.({ ...SETTINGS(), appearance: { theme: 'dark', accent: 'blue', vibrancy: false, glass: false, density: 'comfortable', fontSize: 'medium' } }))
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'))
  })
})

describe('PetApp P3-4', () => {
  it('applies the configured anim/accent for the current state (idle by default)', async () => {
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet.pet-anim-float.pet-accent-none')).not.toBeNull())
  })

  it('switches to the working anim when a run starts', async () => {
    const { container } = render(<PetApp />)
    act(() => emit({ type: 'run:update', run: { id: 'r', workspaceName: 'w', workspacePath: '/w', status: 'run', projects: [], stages: [], pending: [] } }))
    await waitFor(() => expect(container.querySelector('.pet-anim-spin-halo')).not.toBeNull())
  })

  it('reverts done → idle after the timeout', () => {
    vi.useFakeTimers()
    try {
      const { container } = render(<PetApp />)
      act(() => emit({ type: 'run:update', run: { id: 'r', workspaceName: 'w', workspacePath: '/w', status: 'ok', projects: [], stages: [], pending: [] } }))
      expect(container.querySelector('.pet-anim-pulse-ok')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(container.querySelector('.pet-anim-float')).not.toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('toggles ignore-mouse on hover of the interactive stage', async () => {
    const { container } = render(<PetApp />)
    const stage = container.querySelector('.pet-stage')!
    fireEvent.mouseEnter(stage)
    expect(petSetIgnoreMouse).toHaveBeenCalledWith(false)
    fireEvent.mouseLeave(stage)
    expect(petSetIgnoreMouse).toHaveBeenCalledWith(true)
  })

  it('right-clicking the pet opens the native context menu (关闭宠物)', async () => {
    const { container } = render(<PetApp />)
    const hit = container.querySelector('.pet-hit') as HTMLElement
    fireEvent.contextMenu(hit)
    expect((window as any).forge.petContextMenu).toHaveBeenCalled()
  })

  it('re-applies settings on settingsChanged (skin)', async () => {
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet')!.getAttribute('data-skin')).toBe('bot'))
    // fire a CHANGED payload: skin flips 'bot' → 'ghost' to prove live re-derivation from the new settings
    const changed = SETTINGS()
    changed.pet.skin = 'ghost'
    act(() => settingsCb?.(changed))
    await waitFor(() => expect(container.querySelector('.pet')!.getAttribute('data-skin')).toBe('ghost'))
  })

  it('shows the queue for the current workspace and wires send (provider from the live run)', async () => {
    const sendChat = (window as any).forge.sendChat as ReturnType<typeof vi.fn>
    const cancel = (window as any).forge.chatCancelQueued as ReturnType<typeof vi.fn>
    const { container, getByText } = render(<PetApp />)
    // a live run on /w whose first agent provider is 'codex'
    act(() => emit({ type: 'run:update', run: { id: 'r', workspaceName: 'w', workspacePath: '/w', status: 'run', projects: [], stages: [{ key: 'dev', name: 'Dev', state: 'run', agents: [{ id: 'a', name: 'Codex', role: 'dev', provider: 'codex', model: 'm', state: 'run', logs: [] }] }], pending: [] } } as any))
    // queue events for /w (current) and /other (ignored)
    act(() => queueListeners.forEach(l => l({ workspacePath: '/other', busy: false, queue: [{ id: 'z', text: 'nope', source: '你' }] })))
    act(() => queueListeners.forEach(l => l({ workspacePath: '/w', busy: true, queue: [{ id: 'q1', text: '做X', source: '宠物' }] })))
    // open the popup
    const hit = container.querySelector('.pet-hit') as HTMLElement
    await act(async () => { fireEvent.click(hit) })
    await waitFor(() => expect(getByText('指令队列 · 1 · 排队中')).toBeInTheDocument())
    expect(container.querySelector('.pp-q .qt')!.textContent).toBe('做X')
    // send a command → uses run's provider + model (codex → Codex, model 'm' from the live agent)
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '开工' } })
    fireEvent.click(getByText('发送'))
    await waitFor(() => expect(sendChat).toHaveBeenCalled())
    expect(sendChat).toHaveBeenCalledWith(
      { workspacePath: '/w', sessionId: 's-1', agent: 'codex', agentLabel: 'Codex', model: 'm', text: '开工', attachments: [] },
      '宠物'
    )
    // cancel
    fireEvent.click(container.querySelector('.pp-q .qx')!)
    expect(cancel).toHaveBeenCalledWith({ workspacePath: '/w', id: 'q1' })
  })

  it('idle: targets the main-window active workspace, resolving provider/model from its config', async () => {
    let activeCb: (p: string | null) => void = () => {}
    ;(window as any).forge.onActiveWorkspace = (cb: any) => { activeCb = cb; return () => {} }
    ;(window as any).forge.getWorkspace = vi.fn(async () => ({ stages: [{ key: 'requirement', provider: 'codex', model: 'gpt-5' }], projects: [] }))
    const sendChat = (window as any).forge.sendChat as ReturnType<typeof vi.fn>
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet')).not.toBeNull())
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    expect(input.disabled).toBe(true)                          // home / nothing selected → disabled
    act(() => activeCb('/ws/idle'))                            // main window enters an idle workspace
    await waitFor(() => expect((container.querySelector('.pp-send input') as HTMLInputElement).disabled).toBe(false))
    fireEvent.change(input, { target: { value: '做X' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sendChat).toHaveBeenCalled())
    expect(sendChat.mock.calls[0][0]).toMatchObject({ workspacePath: '/ws/idle', agent: 'codex', model: 'gpt-5' })
  })

  it('simple mode: clicking the pet body while an agent runs focuses the workspace (not collapse)', async () => {
    ;(window as any).forge.getSettings = async () => SETTINGS_SIMPLE()
    const petFocusWorkspace = (window as any).forge.petFocusWorkspace as ReturnType<typeof vi.fn>
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet')).not.toBeNull())
    // an agent starts running → the simple status panel shows "执行中"
    act(() => emit({ type: 'run:update', run: { id: 'r', workspaceName: 'w', workspacePath: '/w', status: 'run', projects: [], stages: [], pending: [] } }))
    await waitFor(() => expect(container.querySelector('.pet-simple')).not.toBeNull())
    // clicking the pet body jumps to the running workspace instead of toggling the panel
    await act(async () => { fireEvent.click(container.querySelector('.pet-hit') as HTMLElement) })
    expect(petFocusWorkspace).toHaveBeenCalledWith('/w')
  })

  it('home: enables input after click-selecting a workspace row (no main active workspace)', async () => {
    ;(window as any).forge.onActiveWorkspace = (_cb: any) => () => {}   // never emits → main stays on home
    ;(window as any).forge.listWorkspaces = vi.fn(async () => [
      { name: 'example', path: '/ws/example', projectCount: 2, workflowId: 'std', status: 'idle', pinned: false }
    ])
    ;(window as any).forge.getWorkspace = vi.fn(async () => ({ stages: [{ key: 'develop', provider: 'claude', model: 'opus-4.8' }], projects: [] }))
    const sendChat = (window as any).forge.sendChat as ReturnType<typeof vi.fn>
    const { container, findByText } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet')).not.toBeNull())
    await act(async () => { fireEvent.click(container.querySelector('.pet-hit') as HTMLElement) })  // open → load workspaces
    const row = await findByText('example')
    expect((container.querySelector('.pp-send input') as HTMLInputElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(row) })            // click-select on home
    await waitFor(() => expect((container.querySelector('.pp-send input') as HTMLInputElement).disabled).toBe(false))
    expect(container.querySelector('.pp-ws.cur')).not.toBeNull()   // selected row highlighted
    const input = container.querySelector('.pp-send input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'hi' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(sendChat).toHaveBeenCalled())
    expect(sendChat.mock.calls[0][0]).toMatchObject({ workspacePath: '/ws/example', agent: 'claude' })
  })

  it('opening the pet does not eagerly read sessions for every workspace', async () => {
    ;(window as any).forge.onActiveWorkspace = (_cb: any) => () => {}
    ;(window as any).forge.listWorkspaces = vi.fn(async () => [
      { name: 'Docs A', path: '/Users/me/Documents/a', projectCount: 1, workflowId: 'std', status: 'idle', pinned: false },
      { name: 'Docs B', path: '/Users/me/Documents/b', projectCount: 1, workflowId: 'std', status: 'idle', pinned: false },
    ])
    const sessionList = (window as any).forge.sessionList as ReturnType<typeof vi.fn>
    const { container, findByText } = render(<PetApp />)
    // Wait for settings to apply (interactionMode:'full') before clicking — in simple mode a pet click
    // focuses the app instead of opening the popup.
    await waitFor(() => expect(container.querySelector('.pet')).not.toBeNull())

    await act(async () => { fireEvent.click(container.querySelector('.pet-hit') as HTMLElement) })
    await findByText('Docs A')

    expect(sessionList).not.toHaveBeenCalled()
  })

  it('onPickSess resets petView to main after selecting a session (M3 fix)', async () => {
    // Set up sessionsByWs so petTgt resolves
    let sessChangesCb: ((p: unknown) => void) | null = null
    ;(window as any).forge.onSessionsChanged = (cb: any) => { sessChangesCb = cb; return () => {} }
    ;(window as any).forge.sessionList = vi.fn(async () => ({
      sessions: [
        { id: 's-1', title: '会话A', mode: 'chat', createdAt: 0 },
        { id: 's-2', title: '会话B', mode: 'workflow', createdAt: 1 },
      ],
      activeSessionId: 's-1',
    }))
    ;(window as any).forge.onActiveWorkspace = (cb: any) => { cb('/ws/test'); return () => {} }
    const { container } = render(<PetApp />)
    await act(async () => {})
    // inject sessions via the sessions-changed listener so petTgt has data
    await act(async () => {
      sessChangesCb?.({ workspacePath: '/ws/test', file: { sessions: [{ id: 's-1', title: '会话A', mode: 'chat', createdAt: 0 }, { id: 's-2', title: '会话B', mode: 'workflow', createdAt: 1 }], activeSessionId: 's-1' } })
    })
    // Open popup
    await act(async () => { fireEvent.click(container.querySelector('.pet-hit') as HTMLElement) })
    // Open picker via tg-pick
    await waitFor(() => expect(container.querySelector('.tg-pick')).not.toBeNull())
    fireEvent.click(container.querySelector('.tg-pick')!)
    // Picker should be open (pp-back visible)
    await waitFor(() => expect(container.querySelector('.pp-back')).not.toBeNull())
    // Click a pk-sess to pick session
    const pkSess = container.querySelectorAll('.pk-sess')
    expect(pkSess.length).toBeGreaterThan(0)
    fireEvent.click(pkSess[0])
    // petView should revert to main → pp-back gone, pp-send back
    await waitFor(() => expect(container.querySelector('.pp-back')).toBeNull())
    expect(container.querySelector('.pp-send')).not.toBeNull()
  })

  it('cross-workspace: queue/running/cancel/stop all target the explicit petTarget workspace, not currentWs', async () => {
    // ws-A = explicit petTarget; ws-B = currentWs (main window is in ws-B)
    const WS_A = '/ws/alpha'
    const WS_B = '/ws/beta'
    // Stub localStorage so readStoredTarget() can return an explicit petTarget
    const lsStore: Record<string, string> = {}
    const lsMock = { getItem: (k: string) => lsStore[k] ?? null, setItem: (k: string, v: string) => { lsStore[k] = v }, removeItem: (k: string) => { delete lsStore[k] } }
    vi.stubGlobal('localStorage', lsMock)
    lsStore['forge.pet.target'] = JSON.stringify({ wsPath: WS_A, sessId: 'sa-1' })
    let activeCb: (p: string | null) => void = () => {}
    ;(window as any).forge.onActiveWorkspace = (cb: any) => { activeCb = cb; return () => {} }
    let sessChangesCb: ((p: unknown) => void) | null = null
    ;(window as any).forge.onSessionsChanged = (cb: any) => { sessChangesCb = cb; return () => {} }
    ;(window as any).forge.sessionList = vi.fn(async () => ({
      sessions: [{ id: 'sa-1', title: '会话A', mode: 'chat', createdAt: 0 }],
      activeSessionId: 'sa-1',
    }))
    ;(window as any).forge.listWorkspaces = vi.fn(async () => [
      { name: 'Alpha', path: WS_A, projectCount: 1, workflowId: 'std', status: 'run', pinned: false },
      { name: 'Beta',  path: WS_B, projectCount: 1, workflowId: 'std', status: 'idle', pinned: false },
    ])
    const cancel = (window as any).forge.chatCancelQueued as ReturnType<typeof vi.fn>
    const stop   = (window as any).forge.chatStop         as ReturnType<typeof vi.fn>
    const { container, getByText } = render(<PetApp />)
    // Main window is in ws-B
    await act(async () => { activeCb(WS_B) })
    // Inject sessions for ws-A so petTgt can resolve it
    await act(async () => {
      sessChangesCb?.({ workspacePath: WS_A, file: { sessions: [{ id: 'sa-1', title: '会话A', mode: 'chat', createdAt: 0 }], activeSessionId: 'sa-1' } })
    })
    // Emit queue events: ws-A has a queued item + is running; ws-B has nothing
    act(() => queueListeners.forEach(l => l({ workspacePath: WS_B, busy: false, queue: [], running: null })))
    act(() => queueListeners.forEach(l => l({ workspacePath: WS_A, busy: true,  queue: [{ id: 'qa1', text: 'A的任务', source: '宠物' }], running: { id: 'ra1', text: 'A正在跑' } })))
    // Open popup
    await act(async () => { fireEvent.click(container.querySelector('.pet-hit') as HTMLElement) })
    // Pet should show ws-A's queue (not ws-B's empty queue) and running item
    await waitFor(() => expect(getByText('指令队列 · 1 · 排队中')).toBeInTheDocument())
    // Running item shows 'A正在跑'; queued item shows 'A的任务'
    const qtEls = container.querySelectorAll('.pp-q .qt')
    const qtTexts = Array.from(qtEls).map(el => el.textContent)
    expect(qtTexts).toContain('A的任务')
    expect(qtTexts).toContain('A正在跑')
    // Cancel → must target ws-A, NOT ws-B
    fireEvent.click(container.querySelector('.pp-q .qx')!)
    expect(cancel).toHaveBeenCalledWith({ workspacePath: WS_A, id: 'qa1' })
    expect(cancel).not.toHaveBeenCalledWith({ workspacePath: WS_B, id: 'qa1' })
    // Stop → must target ws-A if stop button present
    const stopBtn = container.querySelector('.pp-stop') as HTMLElement
    if (stopBtn) {
      fireEvent.click(stopBtn)
      expect(stop).toHaveBeenCalledWith({ workspacePath: WS_A })
    }
    vi.unstubAllGlobals()
  })

  it('no explicit petTarget: tgtWs === currentWs (unchanged behavior)', async () => {
    // Verify that without a stored petTarget, queue/cancel/stop still use currentWs
    const WS_C = '/ws/gamma'
    const lsStore: Record<string, string> = {}
    vi.stubGlobal('localStorage', { getItem: (k: string) => lsStore[k] ?? null, setItem: (k: string, v: string) => { lsStore[k] = v }, removeItem: (k: string) => { delete lsStore[k] } })
    let activeCb: (p: string | null) => void = () => {}
    ;(window as any).forge.onActiveWorkspace = (cb: any) => { activeCb = cb; return () => {} }
    const cancel = (window as any).forge.chatCancelQueued as ReturnType<typeof vi.fn>
    const { container, getByText } = render(<PetApp />)
    await act(async () => { activeCb(WS_C) })
    act(() => queueListeners.forEach(l => l({ workspacePath: WS_C, busy: true, queue: [{ id: 'qc1', text: 'C任务', source: '宠物' }], running: null })))
    await act(async () => { fireEvent.click(container.querySelector('.pet-hit') as HTMLElement) })
    await waitFor(() => expect(getByText('指令队列 · 1 · 排队中')).toBeInTheDocument())
    fireEvent.click(container.querySelector('.pp-q .qx')!)
    expect(cancel).toHaveBeenCalledWith({ workspacePath: WS_C, id: 'qc1' })
    vi.unstubAllGlobals()
  })

  it('缩放手柄:pointerdown 一次 petResizeBegin 预扩窗,live 阶段零 IPC 只改 CSS 变量,松手一次 petSetScale', async () => {
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet-resize')).not.toBeNull())
    const handle = container.querySelector('.pet-resize') as HTMLElement
    await act(async () => {
      fireEvent.pointerDown(handle, { button: 0, screenX: 100, screenY: 100, clientX: 100, clientY: 100, pointerId: 1 })
    })
    // 拖动开始:主进程一次性把窗口预扩到最大 scale 足迹
    expect(petResizeBegin).toHaveBeenCalledTimes(1)
    await act(async () => {
      const mv = new Event('pointermove'); (mv as any).screenX = 144; (mv as any).screenY = 144 // dx=dy=44 → 1.5
      window.dispatchEvent(mv)
    })
    await act(async () => {
      const mv = new Event('pointermove'); (mv as any).screenX = 145; (mv as any).screenY = 143 // 仍 ≈1.5
      window.dispatchEvent(mv)
    })
    // live 阶段完全不发 petSetScale(窗口零重排,纯 CSS 缩放),CSS 变量即时跟随 88*1.5=132px
    expect(petSetScale).not.toHaveBeenCalled()
    expect((container.querySelector('.pet-stage') as HTMLElement).style.getPropertyValue('--pet-size')).toBe('132px')
    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    // 松手只发一次 petSetScale(clamp+持久化+dockPet 收到最终尺寸)
    await waitFor(() => expect(petSetScale).toHaveBeenCalledTimes(1))
    expect(petSetScale.mock.calls[0][0]).toBeCloseTo(1.5)
    expect(petResizeBegin).toHaveBeenCalledTimes(1) // begin 全程只有一次
    // 手柄 pointerdown stopPropagation:不得触发 .pet-hit 的拖拽(petSetPosition)
    expect(petSetPosition).not.toHaveBeenCalled()
  })

  it('缩小时光标已越出窗口(mouseleave 后)在窗外松手 → commit 时补发 petSetIgnoreMouse(true)', async () => {
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet-resize')).not.toBeNull())
    const stage = container.querySelector('.pet-stage') as HTMLElement
    const handle = container.querySelector('.pet-resize') as HTMLElement
    fireEvent.mouseEnter(stage)
    await act(async () => {
      fireEvent.pointerDown(handle, { button: 0, screenX: 100, screenY: 100, clientX: 100, clientY: 100, pointerId: 1 })
    })
    // 缩小拖动中窗口收缩,光标越界触发 mouseleave(resize 中被抑制,不即时穿透)
    fireEvent.mouseLeave(stage)
    petSetIgnoreMouse.mockClear()
    await act(async () => {
      const mv = new Event('pointermove'); (mv as any).screenX = 56; (mv as any).screenY = 56
      window.dispatchEvent(mv)
    })
    expect(petSetIgnoreMouse).not.toHaveBeenCalled() // live 阶段不动 ignore-mouse
    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    expect(petSetIgnoreMouse).toHaveBeenCalledWith(true) // 窗外松手补发,恢复点击穿透
  })

  it('从设置读取 pet.scale 映射为 --pet-size CSS 变量', async () => {
    ;(window as any).forge.getSettings = async () => { const s: any = SETTINGS(); s.pet.scale = 1.5; return s }
    const { container } = render(<PetApp />)
    await waitFor(() => expect((container.querySelector('.pet-stage') as HTMLElement).style.getPropertyValue('--pet-size')).toBe('132px'))
  })

  it('persists free position + derived corner to settings on a past-threshold drag (drag → setSettings)', async () => {
    const setSettings = (window as any).forge.setSettings as ReturnType<typeof vi.fn>
    const { container } = render(<PetApp />)
    await waitFor(() => expect(container.querySelector('.pet')).not.toBeNull())
    const hit = container.querySelector('.pet-hit') as HTMLElement
    // pointerdown captures start coords via the async petGetBounds (bounds x:1200,y:600,w:140,h:120 / workArea 1440x900)
    await act(async () => {
      fireEvent.pointerDown(hit, { button: 0, screenX: 1200, screenY: 600, clientX: 1200, clientY: 600, pointerId: 1 })
    })
    // move far left+down past threshold: window x≈100, y≈680; workArea x=0,y=0 → free={x:100,y:680}; center 170 < 720 → corner='left'
    await act(async () => {
      const mv = new Event('pointermove'); (mv as any).screenX = 100; (mv as any).screenY = 680
      window.dispatchEvent(mv)
    })
    await act(async () => { window.dispatchEvent(new Event('pointerup')) })
    // onDropped → getSettings().then(setSettings) is async
    await waitFor(() => expect(setSettings).toHaveBeenCalled())
    const arg = setSettings.mock.calls[setSettings.mock.calls.length - 1][0]
    expect(arg.pet.corner).toBe('left')
    expect(arg.pet.free).toEqual({ x: 100, y: 680 })
    // other pet fields preserved from the getSettings mock (spread kept them)
    expect(arg.pet.skin).toBe('bot')
    expect(arg.pet.states).toEqual(SETTINGS().pet.states)
  })
})
