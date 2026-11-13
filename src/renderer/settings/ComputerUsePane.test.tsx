import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { ComputerUsePane } from './ComputerUsePane'
import { BLOCKED_BUNDLES, type CuStatus } from '@shared/computerUse'
import type { Settings } from '@shared/types'

type ComputerUseSettings = Settings['computerUse']

const okStatus: CuStatus = { supported: true, osOK: true, helper: 'ok', screen: true, ax: true }
const base = (): ComputerUseSettings => ({ provisioned: false, requested: { screen: false, ax: false }, extraBlocked: [], extraAskAlways: [] })

let api: {
  status: ReturnType<typeof vi.fn>; requestPermission: ReturnType<typeof vi.fn>; openSettings: ReturnType<typeof vi.fn>
  runningApps: ReturnType<typeof vi.fn>
}
let relaunch: ReturnType<typeof vi.fn>
const calls: string[] = []

function setup(over: { status?: Partial<CuStatus>; cu?: Partial<ComputerUseSettings>; platform?: string; overrides?: Record<string, string> } = {}) {
  const onChange = vi.fn()
  api.status.mockResolvedValue({ ...okStatus, ...over.status })
  ;(window as any).forge = { platform: over.platform ?? 'darwin', computerUse: api, appRelaunch: relaunch }
  const r = render(<ComputerUsePane computerUse={{ ...base(), ...over.cu }} keybindings={{ overrides: over.overrides ?? {} }} onChange={onChange} />)
  return { onChange, ...r }
}

beforeEach(() => {
  calls.length = 0
  api = {
    status: vi.fn(),
    requestPermission: vi.fn(async () => { calls.push('request'); return { ok: true } }),
    openSettings: vi.fn(async () => { calls.push('open'); return { ok: true } }),
    runningApps: vi.fn(async () => [{ bundleId: 'com.foo.App', name: 'Foo' }, { bundleId: 'com.apple.Terminal', name: 'Terminal' }]),
  }
  relaunch = vi.fn()
})
afterEach(() => cleanup())

describe('ComputerUsePane', () => {
  it('does not probe until mounted, and probes on mount and on window focus', async () => {
    expect(api.status).not.toHaveBeenCalled()
    setup()
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(2))
  })

  it('stops probing on focus after unmount', async () => {
    const { unmount } = setup()
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1))
    unmount()
    window.dispatchEvent(new Event('focus'))
    expect(api.status).toHaveBeenCalledTimes(1)
  })

  it('non-darwin shows one unsupported row', async () => {
    const { container } = setup({ platform: 'win32' })
    expect(screen.getByText('系统 · 暂不支持')).toBeTruthy()
    expect(container.querySelectorAll('.set-row').length).toBe(1)
    expect(api.status).not.toHaveBeenCalled()
  })

  it('screen not granted and not requested: 授权 runs request then open pane', async () => {
    const h = setup({ status: { screen: false } })
    const row = await screen.findByTestId('cu-row-screen')
    await waitFor(() => expect(row.textContent).toContain('未授权'))
    fireEvent.click(row.querySelector('button')!)
    await waitFor(() => expect(api.requestPermission).toHaveBeenCalledWith({ kind: 'screen' }))
    expect(api.openSettings).not.toHaveBeenCalled()
    await waitFor(() => expect(h.onChange).toHaveBeenCalledWith({ requested: { screen: true, ax: false } }))
    await waitFor(() => expect(row.textContent).toContain('授权后需重启'))
  })

  it('requested but still not granted shows 授权后需重启 with 重新启动 and 打开系统设置', async () => {
    setup({ status: { screen: false }, cu: { requested: { screen: true, ax: false } } })
    const row = await screen.findByTestId('cu-row-screen')
    await waitFor(() => expect(row.textContent).toContain('授权后需重启'))
    fireEvent.click(screen.getByText('重新启动'))
    expect(relaunch).toHaveBeenCalled()
    fireEvent.click(screen.getByText('打开系统设置'))
    expect(api.openSettings).toHaveBeenCalledWith({ kind: 'screen' })
  })

  it('granted shows 已授权 and no button', async () => {
    setup({ status: { ax: true }, cu: { requested: { screen: false, ax: true } } })
    const row = await screen.findByTestId('cu-row-ax')
    await waitFor(() => expect(row.textContent).toContain('已授权'))
    expect(row.querySelector('button')).toBeNull()
    expect(row.textContent).not.toContain('授权后需重启')
  })

  it('helper states have their own labels', async () => {
    for (const [h, label] of [['ok', '正常'], ['missing', '组件缺失'], ['failed', '无法启动']] as const) {
      const { unmount } = setup({ status: { helper: h } })
      const row = await screen.findByTestId('cu-row-helper')
      await waitFor(() => expect(row.textContent).toContain(label))
      unmount()
    }
  })

  it('old macOS gets its own row', async () => {
    setup({ status: { osOK: false } })
    await waitFor(() => expect(screen.getByTestId('cu-row-os').textContent).toContain('macOS 14'))
  })

  it('shows the stop shortcut, honouring overrides', async () => {
    setup()
    expect(screen.getByTestId('cu-row-stop').textContent).toContain('⌃⌥⌘Esc')
    cleanup()
    setup({ overrides: { 'computer-use-stop': 'Control+Alt+Shift+K' } })
    expect(screen.getByTestId('cu-row-stop').textContent).toContain('⌃⌥⇧K')
  })

  it('built-in blocked apps are read-only; extra ones can be removed', async () => {
    const { onChange } = setup({ cu: { extraBlocked: ['com.x.Mine'] } })
    const list = screen.getByTestId('cu-list-blocked')
    expect(list.textContent).toContain(BLOCKED_BUNDLES[0])
    const builtin = list.querySelectorAll('[data-builtin="true"]')
    expect(builtin.length).toBeGreaterThan(0)
    builtin.forEach(b => expect(b.querySelector('button')).toBeNull())
    const mine = list.querySelector('[data-bundle="com.x.Mine"]')!
    fireEvent.click(mine.querySelector('button')!)
    expect(onChange).toHaveBeenCalledWith({ extraBlocked: [] })
  })

  it('添加 lists running apps and adds the chosen bundle', async () => {
    const { onChange } = setup({ cu: { extraAskAlways: ['com.a.A'] } })
    const group = screen.getByTestId('cu-group-askAlways')
    fireEvent.click(group.querySelector('[data-add]')!)
    const pick = await screen.findByText('Foo')
    fireEvent.click(pick)
    expect(onChange).toHaveBeenCalledWith({ extraAskAlways: ['com.a.A', 'com.foo.App'] })
  })

  it('running-app picker hides apps already listed (built-in or extra)', async () => {
    setup({ cu: { extraBlocked: ['com.foo.App'] } })
    fireEvent.click(screen.getByTestId('cu-group-blocked').querySelector('[data-add]')!)
    await waitFor(() => expect(api.runningApps).toHaveBeenCalled())
    await screen.findByText('Terminal')
    expect(screen.queryByText('Foo')).toBeNull()
  })

  it('renders no p/small or explanatory class names', async () => {
    const { container } = setup({ status: { screen: false, helper: 'failed' }, cu: { extraBlocked: ['com.x.Mine'] } })
    await screen.findByTestId('cu-row-screen')
    expect(container.querySelector('p, small')).toBeNull()
    for (const el of Array.from(container.querySelectorAll('[class]'))) expect(el.getAttribute('class')).not.toMatch(/hint|desc|help|note|tip|caption/)
  })
})
