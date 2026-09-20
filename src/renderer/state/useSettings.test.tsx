import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSettings } from './useSettings'

let saved: any = null
let settingsCb: ((s: any) => void) | null = null
beforeEach(() => {
  saved = null
  settingsCb = null
  ;(window as any).forge = {
    getSettings: vi.fn(async () => ({ appearance: { theme: 'dark', vibrancy: true, density: 'comfortable', fontSize: 'medium' }, agentProxy: '' })),
    setSettings: vi.fn(async (s: any) => { saved = s; return s }),
    onSettingsChanged: (cb: (s: any) => void) => { settingsCb = cb; return () => {} },
  }
})

describe('useSettings', () => {
  it('loads settings, then update merges appearance + persists', async () => {
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    expect(result.current.settings!.appearance.theme).toBe('dark')

    act(() => { result.current.update({ appearance: { theme: 'light' } }) })
    expect(result.current.settings!.appearance.theme).toBe('light')
    expect(result.current.settings!.appearance.vibrancy).toBe(true)
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved.appearance.theme).toBe('light')

    act(() => { result.current.update({ agentProxy: 'http://x' }) })
    expect(result.current.settings!.agentProxy).toBe('http://x')
  })
  it('falls back to defaults when getSettings returns empty', async () => {
    ;(window as any).forge.getSettings = vi.fn(async () => ({}))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    // 新用户默认亮色主题(与主进程 defaultSettings 保持一致)
    expect(result.current.settings!.appearance.theme).toBe('light')
    expect(result.current.settings!.agentProxy).toBe('')
    expect(result.current.settings!.appIcon).toEqual({ dockIcon: 'ember-violet', showMenuBar: false })
  })

  it('onSettingsChanged 刷新本地快照，改外观不覆盖 pet.free', async () => {
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    // 初始无 free（DEFAULTS.pet 不含 free）
    expect(result.current.settings!.pet.free).toBeUndefined()

    // 模拟另一个窗口（宠物拖动）写入 free 后的广播：payload 是磁盘 re-read 的整份 settings
    act(() => {
      settingsCb!({ pet: { enabled: true, skin: 'ghost', corner: 'right', pos: { bottom: 24 }, free: { x: 2400, y: 800 } } })
    })
    expect(result.current.settings!.pet.free).toEqual({ x: 2400, y: 800 })

    // 现在改外观 → 写出去的补丁里**根本没有 pet**(没动过的键不进写入范围,所以覆盖不了),
    // 而内存里那份快照仍然带着刚刷新的 free。
    act(() => { result.current.update({ appearance: { theme: 'light' } }) })
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved.appearance.theme).toBe('light')
    expect(saved).not.toHaveProperty('pet')
    expect(result.current.settings!.pet.free).toEqual({ x: 2400, y: 800 })
  })

  it('closeAction: 默认 ask,update 可改并持久化,且不被其它更新覆盖', async () => {
    ;(window as any).forge.getSettings = vi.fn(async () => ({}))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    expect(result.current.settings!.closeAction).toBe('ask')

    act(() => { result.current.update({ closeAction: 'hide' }) })
    expect(result.current.settings!.closeAction).toBe('hide')
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved.closeAction).toBe('hide')

    // 后续无关更新**不带** closeAction —— 它没被改过,就不该出现在写入范围里;
    // 内存快照仍然是 hide。
    act(() => { result.current.update({ agentProxy: 'http://x' }) })
    expect(saved).not.toHaveProperty('closeAction')
    expect(result.current.settings!.closeAction).toBe('hide')
  })

  it('pinnedWorkspaces: 从磁盘加载,且不被无关更新清空', async () => {
    ;(window as any).forge.getSettings = vi.fn(async () => ({ pinnedWorkspaces: ['/ws/a', '/ws/b'] }))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    // 加载时必须从磁盘拿到置顶列表(而不是被 DEFAULTS 的 [] 顶掉)
    expect(result.current.settings!.pinnedWorkspaces).toEqual(['/ws/a', '/ws/b'])

    // 改任意无关设置 → 补丁里没有 pinnedWorkspaces,冲不成 []
    act(() => { result.current.update({ appearance: { theme: 'light' } }) })
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved).not.toHaveProperty('pinnedWorkspaces')
    expect(result.current.settings!.pinnedWorkspaces).toEqual(['/ws/a', '/ws/b'])
  })

  it('pinnedWorkspaces: onSettingsChanged 广播(置顶后)刷新快照,不被后续保存覆盖', async () => {
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    // set-pinned handler 写盘后广播的整份 settings(含新置顶)
    act(() => { settingsCb!({ pinnedWorkspaces: ['/ws/x'] }) })
    expect(result.current.settings!.pinnedWorkspaces).toEqual(['/ws/x'])

    act(() => { result.current.update({ agentProxy: 'http://x' }) })
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved).not.toHaveProperty('pinnedWorkspaces')
    expect(result.current.settings!.pinnedWorkspaces).toEqual(['/ws/x'])
  })

  it('★广播只带一半时,另一半留在上一份快照里,不被打回默认', async () => {
    // 连着远程时这条广播是**分半**的:主机推 host 那半(见 remote/eventScope.ts),
    // 本机推 client 那半(见 router.localEvent)。合到 DEFAULTS 上会把另一半打回默认值 ——
    // 表现为「一改主题,代理框突然空了」。
    ;(window as any).forge.getSettings = vi.fn(async () => ({ agentProxy: 'http://mac:7897', closeAction: 'hide' }))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())

    act(() => { settingsCb!({ appearance: { theme: 'light' } }) })   // 只有 client 那半
    expect(result.current.settings!.appearance.theme).toBe('light')
    expect(result.current.settings!.agentProxy).toBe('http://mac:7897')
    expect(result.current.settings!.closeAction).toBe('hide')
  })

  it('onSettingsChanged 用 DEFAULTS 补齐缺失字段', async () => {
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    act(() => { settingsCb!({ appearance: { theme: 'light' } }) })
    expect(result.current.settings!.appearance.theme).toBe('light')
    // 未提供的字段回落 DEFAULTS
    expect(result.current.settings!.pet.corner).toBe('right')
    expect(result.current.settings!.agentProxy).toBe('')
    expect(result.current.settings!.appIcon.dockIcon).toBe('ember-violet')
  })

  /**
   * ★★★2026-09-20 事故的回归测试。
   *
   * 现象:Windows 上那台 app 在设置里动了一个开关,这台 Mac 的 `agentProxy` 就被写成了
   * Windows 的代理端口,codex/claude 全部 ConnectionRefused;同一次还把中转地址抹成了空。
   * 根因不在任何一个字段上,而在**写入范围**:界面把整份快照发了出去,于是「我没动过的字段」
   * 也在写入范围里,而那份快照是**另一台机器**的。
   *
   * 所以这里钉的不是某个值,是那条边界:**发出去的补丁里,只能有这次动过的键**。
   */
  it('★update 只发这次动过的键 —— 整份快照绝不出门', async () => {
    ;(window as any).forge.getSettings = vi.fn(async () => ({
      agentProxy: 'http://127.0.0.1:7897',          // 这台机器的(host 半边)
      relay: { enabled: true, url: 'wss://mine', urlHistory: ['wss://mine'] },
      pinnedWorkspaces: ['/ws/a'],
      appearance: { theme: 'dark' },
    }))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())

    act(() => { result.current.update({ appearance: { theme: 'light' } }) })
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())

    expect(Object.keys(saved)).toEqual(['appearance'])
    expect(saved.appearance.theme).toBe('light')
    // 这三个是别人的东西,一个都不许出现在这次写入里
    expect(saved).not.toHaveProperty('agentProxy')
    expect(saved).not.toHaveProperty('relay')
    expect(saved).not.toHaveProperty('pinnedWorkspaces')
  })

  it('★换了机器就重拉设置 —— 界面里显示的必须是当前这台的值', async () => {
    let onHost: ((s: any) => void) | null = null
    ;(window as any).forge.onHostStatus = (cb: (s: any) => void) => { onHost = cb; return () => {} }
    ;(window as any).forge.hostsStatus = async () => ({ hostId: null, label: '本机' })
    ;(window as any).forge.getSettings = vi.fn(async () => ({ agentProxy: 'http://local:7897' }))

    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    expect(result.current.settings!.agentProxy).toBe('http://local:7897')

    // 连到另一台机器 → 必须重新拉一次,拿那台的值
    ;(window as any).forge.getSettings = vi.fn(async () => ({ agentProxy: 'http://remote:1080' }))
    act(() => { onHost!({ hostId: 'h1', label: 'zghua-3', state: { status: 'ready' } }) })
    await waitFor(() => expect(result.current.settings!.agentProxy).toBe('http://remote:1080'))
    expect((window as any).forge.getSettings).toHaveBeenCalled()
  })

  it('appIcon: update persists icon choice and menu bar visibility', async () => {
    ;(window as any).forge.getSettings = vi.fn(async () => ({}))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())

    act(() => { result.current.update({ appIcon: { dockIcon: 'cobalt-violet', showMenuBar: true } }) })
    expect(result.current.settings!.appIcon).toEqual({ dockIcon: 'cobalt-violet', showMenuBar: true })
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved.appIcon).toEqual({ dockIcon: 'cobalt-violet', showMenuBar: true })
  })
})
