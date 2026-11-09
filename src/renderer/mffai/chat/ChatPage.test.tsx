import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import ChatPage from './ChatPage'
import { DEFAULT_PAGE, route } from '../route'
import { fail, installFakeForge, type CallTable, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { perms, runRow, summary } from '../test/sessions'

let f: FakeForge
const model = { id: 'm1', name: 'M1', context: 1, output: 1, image: false, reasoning: 'none' as const, toolCall: true }

function setup(calls: CallTable = {}) {
  f = installFakeForge({ calls: {
    'session.list': { sessions: [
      summary('a', { title: '本机会话', updatedAt: 5 }),
      summary('b', { title: '跑着的', updatedAt: 4, open: { turnId: 't', parked: true } }),
      summary('im', { title: '手机', origin: 'im', updatedAt: 3 }),
    ] },
    'channel.telegram.chats': { chats: [{ chatId: '7', accountId: '7', sessionId: 'im', queued: 0, running: false }], worktrees: [] },
    'permissions.get': perms('full'),
    'plugins.commands': { commands: [{ name: 'zed:b', plugin: 'zed', description: 'x', argumentHint: '<who>' }] },
    'session.prompt': { accepted: true, turnId: 't9' },
    'plugins.command.run': { accepted: true, turnId: 't9' },
    'session.cancel': { ok: true },
    'session.rename': { ok: true },
    'session.create': { sessionId: 'new1' },
    'executor.runs': { runs: [] },
    'session.delete': { ok: true, redacted: 1, notes: [] },
    ...calls,
  } })
  f.mffai.models.catalog = vi.fn(async () => ({ presets: [], models: { p: [model] }, default: { accountId: 'a1', modelId: 'm1' } }))
  f.mffai.models.accounts = vi.fn(async () => ({ accounts: [{ id: 'a1', presetId: 'p', label: 'acc', state: 'ok' }], secretsBackend: 'keychain' }))
}

const rowOf = (title: string) => [...document.querySelectorAll('.mffai-sess')].find((r) => r.querySelector('.mffai-sess-title')?.textContent === title) as HTMLElement
const box = () => screen.getByRole('textbox', { name: '输入' }) as HTMLTextAreaElement
async function open(title: string) {
  fireEvent.click(await waitFor(() => { const r = rowOf(title); expect(r).toBeTruthy(); return r }))
}

beforeEach(() => { resetSeq(); route.set({ page: 'chat' }) })

describe('ChatPage', () => {
  it('对话 is the default page', () => {
    expect(DEFAULT_PAGE).toBe('chat')
  })

  it('nothing selected: the list and the new-session form', async () => {
    setup()
    render(<ChatPage />)
    await waitFor(() => expect(document.querySelectorAll('.mffai-sess')).toHaveLength(3))
    expect(screen.getByRole('button', { name: '开始' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '输入' })).toBeNull()
  })

  it('selecting a session routes to it; text goes to session.prompt, a command to plugins.command.run', async () => {
    setup()
    render(<ChatPage />)
    await open('本机会话')
    expect(route.get()).toEqual({ page: 'chat', sessionId: 'a' })
    expect(rowOf('本机会话').className).toContain('on')
    fireEvent.change(box(), { target: { value: 'hi' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(f.callsOf('session.prompt')).toEqual([{ commandId: expect.any(String), sessionId: 'a', text: 'hi' }])
    await waitFor(() => expect(f.callsOf('plugins.commands')).toHaveLength(1))
    fireEvent.change(box(), { target: { value: '/zed:b bob' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(f.callsOf('plugins.command.run')).toEqual([{ commandId: expect.any(String), sessionId: 'a', name: 'zed:b', args: 'bob' }])
  })

  it('a send that timed out and is sent again reuses the commandId', async () => {
    let n = 0
    setup({ 'session.prompt': () => (++n === 1 ? fail(-32010, 'timeout') : { accepted: true, turnId: 't' }) })
    render(<ChatPage />)
    await open('本机会话')
    fireEvent.change(box(), { target: { value: 'hi' } })
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(box().value).toBe('hi')
    await act(async () => { fireEvent.keyDown(box(), { key: 'Enter' }) })
    const [a, b] = f.callsOf('session.prompt') as any[]
    expect(b.commandId).toBe(a.commandId)
  })

  it('an open, parked session: 挂起 above the input and 停止 sends session.cancel', async () => {
    setup()
    render(<ChatPage />)
    await open('跑着的')
    expect(within(document.querySelector('.mffai-composer') as HTMLElement).getByText('挂起')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止' })) })
    expect(f.callsOf('session.cancel')).toEqual([{ commandId: expect.any(String), sessionId: 'b' }])
  })

  it('an IM session is read-only: Telegram · name and no textarea', async () => {
    setup({ 'channel.telegram.status': { state: 'online', enabled: true, tokenSet: true, secretsBackend: 'keychain', proxy: 'none', paired: [{ accountId: '7', name: 'Bob', pairedAt: 1 }], pairing: { active: false }, dropped: { unpaired: 0, stale: 0, group: 0, attachment: 0, badUpdate: 0 }, undelivered: 0, problems: [] } })
    render(<ChatPage />)
    await waitFor(() => expect(within(rowOf('手机')).getByText('Bob')).toBeInTheDocument())
    await open('手机')
    expect(screen.queryByRole('textbox', { name: '输入' })).toBeNull()
    expect(screen.getByText('Telegram · Bob')).toBeInTheDocument()
  })

  it('rename: Enter saves through session.rename; a -32010 then a retry reuses the commandId; the list reloads', async () => {
    let n = 0
    setup({ 'session.rename': () => (++n === 1 ? fail(-32010, 'timeout') : { ok: true }) })
    render(<ChatPage />)
    await waitFor(() => expect(rowOf('本机会话')).toBeTruthy())
    fireEvent.doubleClick(rowOf('本机会话').querySelector('.mffai-sess-title')!)
    fireEvent.change(screen.getByRole('textbox', { name: '标题' }), { target: { value: '新标题' } })
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '标题' }), { key: 'Enter' }) })
    expect(await within(screen.getByRole('textbox', { name: '标题' }).closest('.mffai-sess') as HTMLElement).findByText('失败')).toBeInTheDocument()
    const lists = f.callsOf('session.list').length
    await act(async () => { fireEvent.keyDown(screen.getByRole('textbox', { name: '标题' }), { key: 'Enter' }) })
    const [a, b] = f.callsOf('session.rename') as any[]
    expect(a).toEqual({ commandId: expect.any(String), sessionId: 'a', title: '新标题' })
    expect(b.commandId).toBe(a.commandId)
    expect(screen.queryByRole('textbox', { name: '标题' })).toBeNull()
    await waitFor(() => expect(f.callsOf('session.list').length).toBeGreaterThan(lists))
  })

  it('delete: disabled while open; the confirm, then the notes box deletes an n_ and the active session is deselected', async () => {
    setup({
      'executor.runs': { runs: [runRow('r1', 'a', { worktree: { path: '/w', present: true }, changed: 0 })] },
      'session.delete': { ok: true, redacted: 2, notes: ['n_q'] },
      'memory.get': { id: 'n_q', layer: 'memory', text: '引用的那条' },
      'memory.delete': { ok: true, redacted: 1, sources: [] },
    })
    render(<ChatPage />)
    await waitFor(() => expect(rowOf('跑着的')).toBeTruthy())
    fireEvent.click(within(rowOf('跑着的')).getByRole('button', { name: '更多' }))
    expect((screen.getByRole('menuitem', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true)

    await open('本机会话')
    fireEvent.click(within(rowOf('本机会话')).getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const dlg = await screen.findByRole('dialog', { name: '删除会话' })
    await waitFor(() => expect(within(dlg).getByText('删除 worktree').nextSibling!.textContent).toBe('1'))
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '删除' })) })
    expect(f.callsOf('session.delete')).toEqual([{ commandId: expect.any(String), sessionId: 'a' }])
    const box2 = await screen.findByRole('dialog', { name: '仍引用它的记忆 1 条' })
    expect(await within(box2).findByText('引用的那条')).toBeInTheDocument()
    expect(route.get()).toEqual({ page: 'chat' })
    await act(async () => { fireEvent.click(within(box2).getByRole('button', { name: '删除' })) })
    expect(f.callsOf('memory.delete')).toEqual([{ commandId: expect.any(String), id: 'n_q' }])
    expect(await screen.findByRole('dialog', { name: '仍引用它的记忆 0 条' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('no notes: no result box', async () => {
    setup()
    render(<ChatPage />)
    await waitFor(() => expect(rowOf('本机会话')).toBeTruthy())
    fireEvent.click(within(rowOf('本机会话')).getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    const dlg = await screen.findByRole('dialog', { name: '删除会话' })
    await waitFor(() => expect((within(dlg).getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false))
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '删除' })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('新会话: the form, 开始 selects the new session and reloads the list', async () => {
    setup()
    render(<ChatPage />)
    await open('本机会话')
    fireEvent.click(screen.getByRole('button', { name: '新会话' }))
    expect(route.get()).toEqual({ page: 'chat', newSession: {} })
    const start = await screen.findByRole('button', { name: '开始' }) as HTMLButtonElement
    await waitFor(() => expect(start.disabled).toBe(false))
    const lists = f.callsOf('session.list').length
    await act(async () => { fireEvent.click(start) })
    expect(route.get()).toEqual({ page: 'chat', sessionId: 'new1' })
    expect(f.callsOf('session.list').length).toBeGreaterThan(lists)
    expect(document.activeElement).toBe(box())
    expect('origin' in (f.callsOf('session.create')[0] as object)).toBe(false)
  })

  it('route.newSession prefills the cwd', async () => {
    setup()
    route.set({ page: 'chat', newSession: { cwd: '/proj' } })
    render(<ChatPage />)
    expect((await screen.findByRole('textbox', { name: '工作目录' }) as HTMLInputElement).value).toBe('/proj')
  })

  it('session.deleted for the open session goes back to the list', async () => {
    setup()
    render(<ChatPage />)
    await open('本机会话')
    act(() => f.emit(ev('session.deleted', {}, { sessionId: 'a' })))
    expect(route.get()).toEqual({ page: 'chat' })
  })

  it('session.list unsupported: 不支持', async () => {
    setup({ 'session.list': () => fail(-32601) })
    render(<ChatPage />)
    expect(await screen.findByText('不支持')).toBeInTheDocument()
  })

  it('a memory.recommendation event shows the card above the session list; 开会话 opens a prefilled new-session form', async () => {
    setup()
    render(<ChatPage />)
    await waitFor(() => expect(rowOf('本机会话')).toBeTruthy())
    act(() => { f.emit(ev('memory.recommendation', { id: 'r1', category: 'routine', habitId: 'h1', text: '每周一常在 repo 工作', cwd: '/repo' })) })
    expect(await screen.findByText('每周一常在 repo 工作')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '开会话' }))
    expect(route.get()).toEqual({ page: 'chat', newSession: { cwd: '/repo' } })
    expect((await screen.findByRole('textbox', { name: '工作目录' }) as HTMLInputElement).value).toBe('/repo')
    expect(screen.queryByText('每周一常在 repo 工作')).toBeNull()
  })
})
