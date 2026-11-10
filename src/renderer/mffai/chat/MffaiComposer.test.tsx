import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MffaiComposer } from './MffaiComposer'
import { callError, fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

const commands = { commands: [
  { name: 'zed:a', plugin: 'zed', description: 'aaa' },
  { name: 'zed:b', plugin: 'zed', description: 'say hi', argumentHint: '<who>' },
  { name: 'mem:recall', plugin: 'mem', description: 'x' },
] }

let f: FakeForge
beforeEach(() => { resetSeq(); f = installFakeForge({ calls: { 'plugins.commands': commands } }) })

function mount(p: Partial<Parameters<typeof MffaiComposer>[0]> = {}) {
  const props = {
    session: { id: 's1', origin: 'app' as const },
    onSend: vi.fn(async () => {}), onCommand: vi.fn(async () => {}), onStop: vi.fn(),
    canStop: false,
    ...p,
  }
  render(<MffaiComposer {...props} />)
  return props
}
const box = () => screen.getByRole('textbox', { name: '输入' }) as HTMLTextAreaElement
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const options = () => screen.queryAllByRole('option')

describe('MffaiComposer', () => {
  it('Enter sends the text and clears; Shift+Enter does not; no placeholder', async () => {
    const p = mount()
    expect(box().getAttribute('placeholder')).toBeNull()
    type('hello')
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    expect(p.onSend).not.toHaveBeenCalled()
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(p.onSend).toHaveBeenCalledWith('hello')
    expect(box().value).toBe('')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(p.onSend).toHaveBeenCalledTimes(1)
  })

  it('IME composition Enter does not send', () => {
    const p = mount()
    type('ni')
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    expect(p.onSend).not.toHaveBeenCalled()
  })

  it('the / menu lists plugins.commands, filters, shows the argumentHint as a CodeChip; a pick then Enter runs the command', async () => {
    const p = mount()
    type('/')
    await waitFor(() => expect(options()).toHaveLength(3))
    const b = options().find((o) => o.textContent?.includes('zed:b'))!
    expect(within(b).getByText('zed')).toBeInTheDocument()
    expect(b.querySelector('code')!.textContent).toBe('<who>')
    expect(document.querySelector('[placeholder]')).toBeNull()
    type('/zed')
    expect(options()).toHaveLength(2)
    type('/recall')
    expect(options().map((o) => o.querySelector('.mffai-slash-name')!.textContent)).toEqual(['/mem:recall'])
    type('/zed')
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(box().value).toBe('/zed:b ')
    expect(options()).toHaveLength(0)
    type('/zed:b  bob ')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(p.onCommand).toHaveBeenCalledWith('zed:b', 'bob')
    expect(p.onSend).not.toHaveBeenCalled()
  })

  it('a click on an option fills it in; Esc closes the menu', async () => {
    mount()
    type('/')
    await waitFor(() => expect(options()).toHaveLength(3))
    fireEvent.keyDown(box(), { key: 'Escape' })
    expect(options()).toHaveLength(0)
    type('/m')
    fireEvent.mouseDown(options()[0])
    expect(box().value).toBe('/mem:recall ')
  })

  it('an unknown /word goes as plain text', async () => {
    const p = mount()
    type('/nope x')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(p.onSend).toHaveBeenCalledWith('/nope x')
    expect(p.onCommand).not.toHaveBeenCalled()
  })

  it('-32601 from plugins.commands leaves the menu empty', async () => {
    f = installFakeForge({ calls: { 'plugins.commands': () => fail(-32601, 'method not found') } })
    mount()
    type('/')
    await waitFor(() => expect(f.callsOf('plugins.commands')).toHaveLength(1))
    await act(async () => {})
    expect(options()).toHaveLength(0)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('a plugin installed while no composer is mounted (on the plugins page) shows its command on the next mount', async () => {
    const { unmount } = render(<MffaiComposer session={{ id: 's1', origin: 'app' }} onSend={async () => {}} onCommand={async () => {}} onStop={() => {}} canStop={false} />)
    await waitFor(() => expect(f.callsOf('plugins.commands')).toHaveLength(1))
    unmount()
    f.script({ 'plugins.commands': { commands: [...commands.commands, { name: 'new:cmd', plugin: 'new', description: 'n' }] } })
    act(() => f.emit(ev('plugins.installed', { id: 'new', version: '1.0.0', integrity: 'sha256-x', format: 'native', sourceKind: 'path' })))
    mount()
    type('/new')
    expect(await screen.findByRole('option', { name: /new:cmd/ })).toBeInTheDocument()
  })

  it('the cached list shows at once on the next mount while it is fetched again; refreshed on plugins.enabled/disabled/installed/uninstalled', async () => {
    const { unmount } = render(<MffaiComposer session={{ id: 's1', origin: 'app' }} onSend={async () => {}} onCommand={async () => {}} onStop={() => {}} canStop={false} />)
    await waitFor(() => expect(f.callsOf('plugins.commands')).toHaveLength(1))
    unmount()
    f.script({ 'plugins.commands': () => new Promise(() => {}) })
    mount()
    type('/zed')
    expect(await screen.findByRole('option', { name: /zed:a/ })).toBeInTheDocument()
    expect(f.callsOf('plugins.commands')).toHaveLength(2)
    f.script({ 'plugins.commands': commands })
    const types = ['plugins.enabled', 'plugins.disabled', 'plugins.installed', 'plugins.uninstalled'] as const
    for (const [i, t] of types.entries()) {
      const payload = t === 'plugins.installed' ? { id: 'zed', version: '1.0.0', integrity: 'sha256-x', format: 'native', sourceKind: 'path' } : { id: 'zed' }
      act(() => f.emit(ev(t, payload)))
      await waitFor(() => expect(f.callsOf('plugins.commands')).toHaveLength(i + 3))
    }
  })

  it('a forced refetch always wins: a slower cached read or an older refetch answering last does not bring back the old list (M8)', async () => {
    type Cmds = { commands: { name: string; plugin: string; description: string }[] }
    const pending: ((v: Cmds) => void)[] = []
    f.script({ 'plugins.commands': () => new Promise((r) => { pending.push(r) }) })
    const first = render(<MffaiComposer session={{ id: 's1', origin: 'app' }} onSend={async () => {}} onCommand={async () => {}} onStop={() => {}} canStop={false} />)
    await waitFor(() => expect(pending).toHaveLength(1))
    first.unmount()
    mount()
    await waitFor(() => expect(pending).toHaveLength(2))
    const list = (name: string) => ({ commands: [{ name, plugin: 'zed', description: 'd' }] })
    await act(async () => { pending[1](list('zed:new')) })
    await act(async () => { pending[0](list('zed:old')) })
    type('/zed')
    expect(await screen.findByRole('option', { name: /zed:new/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /zed:old/ })).toBeNull()
    act(() => f.emit(ev('plugins.enabled', { id: 'zed' })))
    await waitFor(() => expect(pending).toHaveLength(3))
    act(() => f.emit(ev('plugins.disabled', { id: 'zed' })))
    await waitFor(() => expect(pending).toHaveLength(4))
    await act(async () => { pending[3](list('zed:latest')) })
    await act(async () => { pending[2](list('zed:stale')) })
    expect(await screen.findByRole('option', { name: /zed:latest/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /zed:stale/ })).toBeNull()
  })

  it('a busy send (-32003) shows 忙 and puts the text back', async () => {
    const p = mount({ onSend: vi.fn(async () => { throw callError(-32003, 'busy') }) })
    type('hi')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(p.onSend).toHaveBeenCalled()
    expect(await screen.findByText('忙')).toBeInTheDocument()
    expect(box().value).toBe('hi')
    type('hi!')
    expect(screen.queryByText('忙')).toBeNull()
  })

  it('another failure shows 失败 and puts the text back', async () => {
    mount({ onSend: vi.fn(async () => { throw callError(-32010, 'timeout') }) })
    type('hi')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(box().value).toBe('hi')
  })

  it('停止 with an open turn; a parked turn shows 挂起 · N 运行中', () => {
    const p = mount({ canStop: true, parked: { running: 2 } })
    expect(screen.getByText('挂起 · 2 运行中')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(p.onStop).toHaveBeenCalled()
  })

  it('parked without a known run count shows 挂起', () => {
    mount({ canStop: true, parked: {} })
    expect(screen.getByText('挂起')).toBeInTheDocument()
  })

  it('no 停止 without an open turn', () => {
    mount()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
  })

  it('an IM session has no textarea, a Telegram · name row, and 停止 when a turn is open', () => {
    const p = mount({ session: { id: 's1', origin: 'im' }, imName: 'Alice', canStop: true })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Telegram · Alice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(p.onStop).toHaveBeenCalled()
  })

  it('other non-app origins are read-only too, labelled by origin', () => {
    mount({ session: { id: 's1', origin: 'schedule' } })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('定时')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停止' })).toBeNull()
  })

  it('readOnly disables the textarea', async () => {
    const p = mount({ readOnly: true })
    expect(box().disabled).toBe(true)
    type('x')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(p.onSend).not.toHaveBeenCalled()
  })
  describe('08b', () => {
    it('info chips render only the fields given; never a placeholder', () => {
      mount({ info: { model: 'claude-sonnet-4-5', cwd: '/w/forge-api', mode: 'auto' } })
      const chips = () => [...document.querySelectorAll('.mffai-cinfo')].map((c) => c.textContent)
      expect(chips()).toEqual(['claude-sonnet-4-5', 'forge-api', '自动放行'])
      expect(document.querySelector('[placeholder]')).toBeNull()
    })

    it('info chips: only cwd given → only that chip; none given → none', () => {
      mount({ info: { cwd: '/w/x' } })
      expect([...document.querySelectorAll('.mffai-cinfo')].map((c) => c.textContent)).toEqual(['x'])
    })

    it('no info → no chips', () => {
      mount()
      expect(document.querySelectorAll('.mffai-cinfo')).toHaveLength(0)
    })

    it('the round send button sends like Enter; it is disabled while the box is empty', async () => {
      const p = mount()
      const send = () => screen.getByRole('button', { name: '发送' }) as HTMLButtonElement
      expect(send().disabled).toBe(true)
      type('hello')
      expect(send().disabled).toBe(false)
      await act(async () => { fireEvent.click(send()) })
      expect(p.onSend).toHaveBeenCalledWith('hello')
      expect(box().value).toBe('')
    })

    it('with an open turn the round button is 停止 instead of 发送', () => {
      const p = mount({ canStop: true })
      expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
      const stop = screen.getByRole('button', { name: '停止' })
      expect(stop.classList.contains('mffai-cround')).toBe(true)
      fireEvent.click(stop)
      expect(p.onStop).toHaveBeenCalled()
    })

    it('the / menu row: name, argumentHint as a CodeChip, the description, the plugin', async () => {
      mount()
      type('/')
      await waitFor(() => expect(options()).toHaveLength(3))
      const b = options().find((o) => o.textContent?.includes('zed:b'))!
      expect(b.querySelector('code')!.textContent).toBe('<who>')
      expect(within(b).getByText('say hi')).toBeInTheDocument()
      expect(b.querySelector('.slash-tag')!.textContent).toBe('zed')
    })

    it('read-only: a dashed source bar with the origin icon and chip; 挂起 above it, inside .mffai-composer', () => {
      mount({ session: { id: 's1', origin: 'im' }, imName: 'Alice', canStop: true, parked: { running: 1 } })
      const ro = document.querySelector('.mffai-composer.mffai-composer-ro')!
      const bar = ro.querySelector('.mffai-srcbar')!
      expect(bar.querySelector('.mffai-origin[data-origin="im"]')).not.toBeNull()
      expect(within(bar as HTMLElement).getByText('Telegram · Alice')).toBeInTheDocument()
      expect(within(bar as HTMLElement).getByRole('button', { name: '停止' })).toBeInTheDocument()
      const top = within(ro as HTMLElement).getByText('挂起 · 1 运行中')
      expect(bar.contains(top)).toBe(false)
      expect(top.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })
      it('fix: the / menu description is third-party text: PText with visible escapes, inside the ellipsis span', async () => {
      f.script({ 'plugins.commands': { commands: [{ name: 'zed:z', plugin: 'zed', description: 'safe\u202Etxt a\u200Bb' }] } })
      mount()
      type('/')
      await waitFor(() => expect(options()).toHaveLength(1))
      const about = options()[0].querySelector('.mffai-slash-about')!
      const p = about.querySelector('.mffai-ptext')!
      expect(p.textContent).toBe('safe\\u{202E}txt a\\u{200B}b')
      expect(p.querySelectorAll('.mffai-esc')).toHaveLength(2)
      expect(about.innerHTML).not.toMatch(/[\u202E\u200B]/)
    })
})
})
