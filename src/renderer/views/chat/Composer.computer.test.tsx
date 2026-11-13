import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { Composer } from './Composer'
import type { ProviderInfo } from '@shared/types'
import type { CuStatus } from '@shared/computerUse'

const providers: ProviderInfo[] = [
  { id: 'claude', displayName: 'Claude Code', installed: true, models: [{ id: 'opus-4.8', label: 'opus-4.8' }] },
  { id: 'cursor', displayName: 'Cursor', installed: true, models: [{ id: 'auto', label: 'auto' }] },
  { id: 'codex', displayName: 'Codex', installed: true, models: [{ id: 'gpt-6', label: 'gpt-6' }] },
]
const ok: CuStatus = { supported: true, osOK: true, helper: 'ok', screen: true, ax: true }
let relaunch: ReturnType<typeof vi.fn>
beforeEach(() => {
  relaunch = vi.fn()
  ;(window as any).forge = { openFiles: vi.fn(async () => []), savePaste: vi.fn(), appRelaunch: relaunch }
})

type CU = NonNullable<React.ComponentProps<typeof Composer>['computerUse']>
const cu = (over: Partial<CU> = {}): CU => ({ supported: true, mode: 'off', status: null, remote: false, setMode: vi.fn(), stop: vi.fn(), openSettings: vi.fn(), isPhysical: () => true, ...over })
/** a press the OS reported: mousedown on the item, then its click with a click count */
const press = (el: Element) => { fireEvent.mouseDown(el); fireEvent.click(el, { detail: 1 }) }
const r = (computerUse: CU | undefined, agentId = 'claude', permissionMode: any = 'auto', extra: Record<string, unknown> = {}) =>
  render(
    <Composer providers={providers} disabled={false} onSend={vi.fn()} computerUse={computerUse}
      selection={{ agentId, modelId: providers.find((p) => p.id === agentId)!.models[0].id, permissionMode, browserUse: 'off' }}
      onSelectionChange={() => {}} {...extra} />,
  )
const chip = () => document.querySelector('#computerMenu .cb-computer') as HTMLButtonElement | null

describe('电脑操作 chip', () => {
  it('sits after #browserMenu with the mode label', () => {
    r(cu({ mode: 'ask', status: ok }))
    expect(chip()!.textContent).toBe('电脑 · 每次询问')
    const browser = document.querySelector('#browserMenu')!
    expect(browser.nextElementSibling?.id).toBe('computerMenu')
    expect(chip()!.className).toContain('computer-ask')
  })

  it.each([
    ['cursor 不支持', () => r(cu(), 'cursor')],
    ['看远程主机时', () => r(cu({ remote: true }))],
    ['平台不支持', () => r(cu({ supported: false }))],
    ['没给 computerUse', () => r(undefined)],
  ])('hidden: %s', (_n, go) => {
    go()
    expect(document.querySelector('#computerMenu')).toBeNull()
  })

  it('codex shows the chip too', () => {
    r(cu(), 'codex', 'full')
    expect(chip()).toBeTruthy()
  })

  it('status without a grant: 电脑 · 需授权, click opens settings and no menu', () => {
    const c = cu({ status: { ...ok, screen: false }, mode: 'ask' })
    r(c)
    expect(chip()!.textContent).toBe('电脑 · 需授权')
    fireEvent.click(chip()!)
    expect(c.openSettings).toHaveBeenCalledTimes(1)
    expect(document.querySelector('#computerMenu.open')).toBeNull()
  })

  it('status unknown: opening asks for a fresh status first; no grant then goes to settings, a grant opens the menu', async () => {
    const refresh = vi.fn(async () => ({ ...ok, ax: false }))
    const c = cu({ refreshStatus: refresh } as never)
    r(c)
    expect(refresh).not.toHaveBeenCalled() // never on mount
    fireEvent.click(chip()!)
    await waitFor(() => expect(c.openSettings).toHaveBeenCalled())
    expect(refresh).toHaveBeenCalledTimes(1)

    document.body.innerHTML = ''
    const refresh2 = vi.fn(async () => ok)
    const c2 = cu({ refreshStatus: refresh2 } as never)
    r(c2)
    fireEvent.click(chip()!)
    await waitFor(() => expect(document.querySelector('#computerMenu.open')).toBeTruthy())
    expect(c2.openSettings).not.toHaveBeenCalled()
  })

  it('a stale 需授权 status is refreshed on click: the grant was given meanwhile, so the menu opens', async () => {
    const refresh = vi.fn(async () => ok)
    const c = cu({ status: { ...ok, screen: false }, mode: 'off', refreshStatus: refresh } as never)
    r(c)
    expect(chip()!.textContent).toBe('电脑 · 需授权')
    fireEvent.click(chip()!)
    await waitFor(() => expect(document.querySelector('#computerMenu.open')).toBeTruthy())
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(c.openSettings).not.toHaveBeenCalled()
  })

  it('mode off with an old good status is also refreshed before the menu opens', async () => {
    const refresh = vi.fn(async () => ({ ...ok, ax: false }))
    const c = cu({ status: ok, mode: 'off', refreshStatus: refresh } as never)
    r(c)
    fireEvent.click(chip()!)
    await waitFor(() => expect(c.openSettings).toHaveBeenCalled())
  })

  it('window focus refreshes the status only when a grant is missing or the mode is on; never for an untouched user', () => {
    const refresh = vi.fn(async () => ok)
    r(cu({ status: null, mode: 'off', refreshStatus: refresh } as never))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(refresh).not.toHaveBeenCalled()
    document.body.innerHTML = ''
    const refresh2 = vi.fn(async () => ok)
    r(cu({ status: { ...ok, ax: false }, mode: 'off', refreshStatus: refresh2 } as never))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(refresh2).toHaveBeenCalledTimes(1)
    document.body.innerHTML = ''
    const refresh3 = vi.fn(async () => ok)
    r(cu({ status: ok, mode: 'ask', refreshStatus: refresh3 } as never))
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(refresh3).toHaveBeenCalledTimes(1)
  })

  it('需重启 while a turn is running asks to confirm first; the second click relaunches', async () => {
    const c = cu({ status: ok, setMode: vi.fn(async () => 'restart_required') as never })
    r(c, 'claude', 'auto', { busy: true })
    fireEvent.click(chip()!)
    await act(async () => { press(screen.getByText('每次询问 · 截屏发给模型')) })
    await waitFor(() => expect(chip()!.textContent).toBe('电脑 · 需重启'))
    fireEvent.click(chip()!)
    expect(relaunch).not.toHaveBeenCalled()
    expect(chip()!.textContent).toBe('确认重启 · 会中断运行中的任务')
    fireEvent.click(chip()!)
    expect(relaunch).toHaveBeenCalledTimes(1)
  })

  it('the two status-independent conflicts show even while status is unknown', () => {
    r(cu({ mode: 'ask', status: null }), 'claude', 'readonly')
    expect(document.querySelector('.browser-conflict-hint')).toBeTruthy()
    expect((document.querySelector('#sendBtn') as HTMLButtonElement).disabled).toBe(true)
    document.body.innerHTML = ''
    r(cu({ mode: 'ask', status: null }), 'codex', 'auto')
    expect(document.querySelector('.browser-conflict-hint')).toBeTruthy()
    document.body.innerHTML = ''
    r(cu({ mode: 'ask', status: null }), 'claude', 'auto')
    expect(document.querySelector('.browser-conflict-hint')).toBeNull()
  })

  it('busyBy: 电脑 · <title>在用 and disabled', () => {
    r(cu({ busyBy: { title: '整理发票' }, status: ok }))
    expect(chip()!.textContent).toBe('电脑 · 整理发票在用')
    expect(chip()!.disabled).toBe(true)
  })

  it('disabled under 只读 permission and in a read-only session', () => {
    r(cu({ status: ok }), 'claude', 'readonly')
    expect(chip()!.disabled).toBe(true)
    document.body.innerHTML = ''
    r(cu({ status: ok }), 'claude', 'auto', { readOnly: true })
    expect(chip()!.disabled).toBe(true)
  })

  it('menu labels are exactly the three modes (+ 停止 when on) and pick calls setMode', () => {
    const c = cu({ status: ok })
    r(c)
    fireEvent.click(chip()!)
    // status known → opens straight away
    const items = Array.from(document.querySelectorAll('#computerMenu .menu-item')).map((e) => e.textContent)
    expect(items).toEqual(['关闭', '每次询问 · 截屏发给模型', '放行 · 截屏发给模型'])
    press(screen.getByText('放行 · 截屏发给模型'))
    expect(c.setMode).toHaveBeenCalledWith('allow')
  })

  it('when on, the menu has 停止 which calls stop', () => {
    const c = cu({ mode: 'ask', status: ok })
    r(c)
    fireEvent.click(chip()!)
    const items = Array.from(document.querySelectorAll('#computerMenu .menu-item')).map((e) => e.textContent)
    expect(items).toEqual(['关闭', '每次询问 · 截屏发给模型', '放行 · 截屏发给模型', '停止'])
    fireEvent.click(screen.getByText('停止'))
    expect(c.stop).toHaveBeenCalled()
  })

  it('restart_required: chip becomes 电脑 · 需重启 and a click relaunches', async () => {
    const c = cu({ status: ok, setMode: vi.fn(async () => 'restart_required') as never })
    r(c)
    fireEvent.click(chip()!)
    await act(async () => { press(screen.getByText('每次询问 · 截屏发给模型')) })
    await waitFor(() => expect(chip()!.textContent).toBe('电脑 · 需重启'))
    fireEvent.click(chip()!)
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(document.querySelector('#computerMenu.open')).toBeNull()
  })

  it('other refusals show their text in the menu, which stays open', async () => {
    const c = cu({ status: ok, setMode: vi.fn(async () => 'busy') as never })
    r(c)
    fireEvent.click(chip()!)
    await act(async () => { press(screen.getByText('放行 · 截屏发给模型')) })
    await waitFor(() => expect(screen.getByText('另一个会话正在使用电脑操作')).toBeTruthy())
    expect(document.querySelector('#computerMenu.open')).toBeTruthy()
  })

  it('M-14: an invalid_args refusal shows its sentence, not a blank line', async () => {
    const c = cu({ status: ok, setMode: vi.fn(async () => 'invalid_args') as never })
    r(c)
    fireEvent.click(chip()!)
    await act(async () => { press(screen.getByText('放行 · 截屏发给模型')) })
    await waitFor(() => expect(document.querySelector('#computerMenu .cu-err')?.textContent).toBe('参数不合法'))
  })

  describe('conflicts block sending with the browser banner style', () => {
    it('on + 只读 → banner and send disabled', () => {
      r(cu({ mode: 'ask', status: ok }), 'claude', 'readonly')
      const banner = document.querySelector('.browser-conflict-hint')!
      expect(banner.textContent).toMatch(/^⚠️ 已暂停发送:/)
      expect((document.querySelector('#sendBtn') as HTMLButtonElement).disabled).toBe(true)
    })
    it('codex + auto, and a missing grant while on', () => {
      r(cu({ mode: 'ask', status: ok }), 'codex', 'auto')
      expect(document.querySelector('.browser-conflict-hint')).toBeTruthy()
      document.body.innerHTML = ''
      r(cu({ mode: 'ask', status: { ...ok, screen: false } }))
      expect(document.querySelector('.browser-conflict-hint')).toBeTruthy()
      expect((document.querySelector('#sendBtn') as HTMLButtonElement).disabled).toBe(true)
    })
    it('Enter does not send either', () => {
      const onSend = vi.fn()
      render(<Composer providers={providers} disabled={false} onSend={onSend} computerUse={cu({ mode: 'ask', status: ok })}
        selection={{ agentId: 'claude', modelId: 'opus-4.8', permissionMode: 'readonly', browserUse: 'off' }} onSelectionChange={() => {}} />)
      const ta = document.querySelector('textarea')!
      fireEvent.change(ta, { target: { value: 'hi' } })
      fireEvent.keyDown(ta, { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
    })
    it('mode off or no conflict: no banner, send enabled', () => {
      r(cu({ mode: 'off', status: ok }), 'claude', 'readonly')
      expect(document.querySelector('.browser-conflict-hint')).toBeNull()
      document.body.innerHTML = ''
      r(cu({ mode: 'ask', status: ok }), 'claude', 'full')
      expect(document.querySelector('.browser-conflict-hint')).toBeNull()
    })
  })

  it('no explanatory text in the chip or its menu', () => {
    r(cu({ status: ok, mode: 'ask' }))
    fireEvent.click(chip()!)
    const m = document.querySelector('#computerMenu')!
    expect(m.querySelector('p, small')).toBeNull()
    m.querySelectorAll('*').forEach((el) => expect(String(el.getAttribute('class') ?? '')).not.toMatch(/hint|desc|help|note|tip|caption|pm-d/))
  })

  describe('I-2: widening picks (off → on, ask → allow) take only a physical press', () => {
    const item = (id: string) => document.querySelector(`#computerMenu [data-computer="${id}"]`) as HTMLButtonElement
    it('the default check is isTrusted: a script-dispatched press (jsdom isTrusted:false) does not widen', async () => {
      const c = cu({ status: ok, isPhysical: undefined })
      r(c)
      fireEvent.click(chip()!)
      await act(async () => { press(item('ask')) })
      expect(c.setMode).not.toHaveBeenCalled()
    })

    it.each([['off', 'ask'], ['off', 'allow'], ['ask', 'allow']] as const)('%s → %s: detail 0 (keyboard / AXPress), no mousedown or a mousedown elsewhere does nothing; a press does', async (from, to) => {
      const c = cu({ status: ok, mode: from })
      r(c)
      fireEvent.click(chip()!)
      expect(item(to).tabIndex).toBe(-1)
      await act(async () => {
        fireEvent.mouseDown(item(to)); fireEvent.click(item(to), { detail: 0 })
        fireEvent.click(item(to), { detail: 1 })
        fireEvent.mouseDown(item('off')); fireEvent.click(item(to), { detail: 1 })
      })
      expect(c.setMode).not.toHaveBeenCalled()
      await act(async () => { press(item(to)) })
      expect(c.setMode).toHaveBeenCalledWith(to)
    })

    it.each([['allow', 'ask'], ['allow', 'off'], ['ask', 'off']] as const)('%s → %s narrows: a keyboard click (detail 0) works and the item stays focusable', async (from, to) => {
      const c = cu({ status: ok, mode: from, isPhysical: () => false })
      r(c)
      fireEvent.click(chip()!)
      expect(item(to).tabIndex).toBe(0)
      await act(async () => { fireEvent.click(item(to), { detail: 0 }) })
      expect(c.setMode).toHaveBeenCalledWith(to)
    })

    it('停止 takes a keyboard click', () => {
      const c = cu({ status: ok, mode: 'allow', isPhysical: () => false })
      r(c)
      fireEvent.click(chip()!)
      fireEvent.click(screen.getByText('停止'), { detail: 0 })
      expect(c.stop).toHaveBeenCalled()
    })
  })
})
