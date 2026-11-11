import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AddAccountDrawer } from './AddAccountDrawer'
import ConnectionsPage from './ConnectionsPage'
import { installFakeForge, type FakeForge } from '../test/fakeForge'

let f: FakeForge
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const presets = [
  { id: 'p-key', label: 'Key套餐', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' },
  { id: 'p-gpt', label: 'ChatGPT', billing: 'subscription', restriction: 'none', auth: 'chatgpt-oauth', protocols: [], docsUrl: '' },
]

function connections() {
  f = installFakeForge()
  f.mffai.models.catalog.mockResolvedValue({ presets, models: {} } as never)
  f.mffai.models.accounts.mockResolvedValue({ accounts: [], secretsBackend: 'keychain' })
  f.mffai.models.addAccount.mockResolvedValue({} as never)
  render(<ConnectionsPage />)
}
const openBtn = () => screen.getByRole('button', { name: '添加账号' })
const open = async () => {
  await waitFor(() => expect(openBtn()).not.toBeDisabled())
  fireEvent.click(openBtn())
}

describe('AddAccountDrawer', () => {
  it('closed: renders nothing and does not mount its children', () => {
    const probe = vi.fn(() => <input type="password" />)
    const Probe = probe
    const { container } = render(<AddAccountDrawer open={false} onClose={() => {}}><Probe /></AddAccountDrawer>)
    expect(container.innerHTML).toBe('')
    expect(probe).not.toHaveBeenCalled()
  })

  it('open: a dim and an aside with the 添加账号 head, a close button and the children', () => {
    render(<AddAccountDrawer open onClose={() => {}}><span>body</span></AddAccountDrawer>)
    const aside = document.querySelector('aside.mffai-drawer') as HTMLElement
    expect(document.querySelector('.mffai-drawer-dim')).not.toBeNull()
    expect(aside).toHaveTextContent('添加账号')
    expect(aside).toHaveTextContent('body')
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument()
  })

  it('Esc, the dim and the close button each call onClose', () => {
    const onClose = vi.fn()
    render(<AddAccountDrawer open onClose={onClose}><span>body</span></AddAccountDrawer>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(document.querySelector('.mffai-drawer-dim')!)
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('a key that is not Escape does nothing, and a closed drawer ignores Esc', () => {
    const onClose = vi.fn()
    const { rerender } = render(<AddAccountDrawer open onClose={onClose}><span>b</span></AddAccountDrawer>)
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(onClose).not.toHaveBeenCalled()
    rerender(<AddAccountDrawer open={false} onClose={onClose}><span>b</span></AddAccountDrawer>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('AddAccountDrawer as a modal dialog', () => {
  it('role=dialog, aria-modal, named 添加账号; the first field gets focus and focus goes back on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { rerender } = render(<AddAccountDrawer open onClose={() => {}}><select aria-label="套餐"><option>a</option></select><input aria-label="名字" /></AddAccountDrawer>)
    const dlg = screen.getByRole('dialog', { name: '添加账号' })
    expect(dlg.tagName).toBe('ASIDE')
    expect(dlg.classList.contains('mffai-drawer')).toBe(true)
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '套餐' }))
    rerender(<AddAccountDrawer open={false} onClose={() => {}}><span /></AddAccountDrawer>)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('Tab from the last control wraps to the first (× 关闭), Shift+Tab from the first wraps to the last', () => {
    render(<AddAccountDrawer open onClose={() => {}}><input aria-label="名字" /><button>保存</button></AddAccountDrawer>)
    const first = screen.getByRole('button', { name: '关闭' }), last = screen.getByRole('button', { name: '保存' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    // 中间的 Tab 交给浏览器
    const mid = screen.getByRole('textbox', { name: '名字' })
    mid.focus()
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    mid.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('with no fields the dialog itself takes focus', () => {
    render(<AddAccountDrawer open onClose={() => {}}><span>body</span></AddAccountDrawer>)
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: '添加账号' }))
  })

  it('the top follows the measured page header, not a fixed 53px', () => {
    const main = document.createElement('div')
    main.className = 'mffai-main'
    const head = document.createElement('div')
    head.className = 'mffai-head'
    main.appendChild(head)
    document.body.appendChild(main)
    const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    main.getBoundingClientRect = () => box(10, 800)
    head.getBoundingClientRect = () => box(10, 91)
    render(<AddAccountDrawer open onClose={() => {}}><span>b</span></AddAccountDrawer>, { container: main.appendChild(document.createElement('div')) })
    expect((document.querySelector('aside.mffai-drawer') as HTMLElement).style.top).toBe('81px')
    expect((document.querySelector('.mffai-drawer-dim') as HTMLElement).style.top).toBe('81px')
    const css = readFileSync(resolve(__dirname, '../styles/pages.css'), 'utf8')
    expect(css).not.toMatch(/53px/)
    expect(css).toMatch(/\.mffai-drawer \{[^}]*top: var\(--mffai-head-h\)/)
    main.remove()
  })
})

describe('the drawer on the 模型 tab', () => {
  it('the header 添加账号 opens it with AddAccount inside; Esc closes it and the password input is gone', async () => {
    connections()
    await open()
    const aside = document.querySelector('aside.mffai-drawer') as HTMLElement
    expect(aside.querySelector('input[type=password]')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('aside.mffai-drawer')).toBeNull()
    expect(document.querySelector('input[type=password]')).toBeNull()
  })

  it('the dim closes it and 取消 in the form closes it too', async () => {
    connections()
    await open()
    fireEvent.click(document.querySelector('.mffai-drawer-dim')!)
    expect(document.querySelector('aside.mffai-drawer')).toBeNull()
    fireEvent.click(openBtn())
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'sk-typed' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.querySelector('aside.mffai-drawer')).toBeNull()
    fireEvent.click(openBtn())
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('')
  })

  it('a failed add keeps the drawer open and clears the key', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    connections()
    f.mffai.models.addAccount.mockRejectedValue(new Error('x'))
    await open()
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'sk-bad' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await screen.findByText('失败')
    expect(document.querySelector('aside.mffai-drawer')).not.toBeNull()
    expect((document.querySelector('input[type=password]') as HTMLInputElement).value).toBe('')
  })

  it('a successful add closes the drawer, reloads the list, and the key is nowhere (DOM, console, storage)', async () => {
    const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    const memStorage = (): Storage => {
      const d: Record<string, string> = {}
      return {
        getItem: (k) => d[k] ?? null, setItem: (k, v) => { d[k] = v }, removeItem: (k) => { delete d[k] },
        clear: () => { for (const k of Object.keys(d)) delete d[k] }, key: (i) => Object.keys(d)[i] ?? null,
        get length() { return Object.keys(d).length },
      }
    }
    vi.stubGlobal('localStorage', memStorage())
    vi.stubGlobal('sessionStorage', memStorage())
    const secret = 'sk-super-secret-42'
    connections()
    await open()
    const before = f.mffai.models.accounts.mock.calls.length
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: secret } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(f.mffai.models.addAccount).toHaveBeenCalledWith({ presetId: 'p-key', apiKey: secret }))
    await waitFor(() => expect(document.querySelector('aside.mffai-drawer')).toBeNull())
    await waitFor(() => expect(f.mffai.models.accounts.mock.calls.length).toBeGreaterThan(before))
    expect(document.body.innerHTML).not.toContain(secret)
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret)
    const dump = (s: Storage) => Object.keys(s).map((k) => s.getItem(k)).join('')
    expect(dump(localStorage)).not.toContain(secret)
    expect(dump(sessionStorage)).not.toContain(secret)
  })

  it('while addAccount is in flight Esc, the dim, × and 取消 do not close; a second add is not sent; it closes when the call finishes', async () => {
    connections()
    let done!: () => void
    f.mffai.models.addAccount.mockImplementation(() => new Promise((res) => { done = () => res({} as never) }))
    await open()
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'sk-pending' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await waitFor(() => expect(f.mffai.models.addAccount).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('.mffai-drawer-dim')!)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(document.querySelector('aside.mffai-drawer')).not.toBeNull()
    fireEvent.change(document.querySelector('input[type=password]')!, { target: { value: 'sk-second' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(f.mffai.models.addAccount).toHaveBeenCalledTimes(1)
    await act(async () => { done() })
    await waitFor(() => expect(document.querySelector('aside.mffai-drawer')).toBeNull())
    expect(f.mffai.models.addAccount).toHaveBeenCalledTimes(1)
  })

  it('closing the drawer on a pending ChatGPT login cancels the flow', async () => {
    connections()
    f.mffai.chatgpt.begin.mockResolvedValue({ flowId: 'f1' } as never)
    f.mffai.chatgpt.cancel.mockResolvedValue({ ok: true } as never)
    await open()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-gpt' } })
    fireEvent.click(screen.getByRole('button', { name: '用 ChatGPT 登录' }))
    await screen.findByRole('button', { name: '取消' })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(f.mffai.chatgpt.cancel).toHaveBeenCalledWith('f1'))
  })
})
