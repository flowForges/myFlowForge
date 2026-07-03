import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useSettings } from './useSettings'

let saved: any = null
let settingsCb: ((s: any) => void) | null = null
beforeEach(() => {
  saved = null
  settingsCb = null
  ;(window as any).forge = {
    getSettings: vi.fn(async () => ({ appearance: { theme: 'dark', vibrancy: true, density: 'comfortable', fontSize: 'medium' }, termProxy: '' })),
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

    act(() => { result.current.update({ termProxy: 'http://x' }) })
    expect(result.current.settings!.termProxy).toBe('http://x')
  })
  it('falls back to defaults when getSettings returns empty', async () => {
    ;(window as any).forge.getSettings = vi.fn(async () => ({}))
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    // 新用户默认亮色主题(与主进程 defaultSettings 保持一致)
    expect(result.current.settings!.appearance.theme).toBe('light')
    expect(result.current.settings!.termProxy).toBe('')
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

    // 现在改外观 → 写回时必须保留刚刷新的 free
    act(() => { result.current.update({ appearance: { theme: 'light' } }) })
    await waitFor(() => expect((window as any).forge.setSettings).toHaveBeenCalled())
    expect(saved.appearance.theme).toBe('light')
    expect(saved.pet.free).toEqual({ x: 2400, y: 800 })
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

    // 后续无关更新必须带着 closeAction 一起写回,不能丢
    act(() => { result.current.update({ termProxy: 'http://x' }) })
    expect(saved.closeAction).toBe('hide')
  })

  it('onSettingsChanged 用 DEFAULTS 补齐缺失字段', async () => {
    const { result } = renderHook(() => useSettings())
    await waitFor(() => expect(result.current.settings).not.toBeNull())
    act(() => { settingsCb!({ appearance: { theme: 'light' } }) })
    expect(result.current.settings!.appearance.theme).toBe('light')
    // 未提供的字段回落 DEFAULTS
    expect(result.current.settings!.pet.corner).toBe('right')
    expect(result.current.settings!.termProxy).toBe('')
    expect(result.current.settings!.appIcon.dockIcon).toBe('ember-violet')
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
