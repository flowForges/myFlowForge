// Telegram 子页(08 §10.3、Review Focus 7、8):状态行、dropped 小表、未送达、清除 webhook 只在 conflict、令牌、
// 已配对和撤销、启用和过期分钟(整份配置)、项目、聊天,-32601 → 不支持,channel.* 事件后重取。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Telegram } from './Telegram'
import { route } from '../route'
import { fail, installFakeForge, type CallTable, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { perms } from '../test/sessions'
import { tgCalls, tgConfig, tgStatus } from '../test/telegram'

// 运行时拼出来:源码里不出现一个像真令牌的字面量
const TOKEN = ['123456789', 'AAFake', 'TokenValue_xyz'].join(':')

let f: FakeForge
let spies: ReturnType<typeof vi.spyOn>[]

async function mount(calls: CallTable = tgCalls()) {
  f = installFakeForge({ calls })
  render(<Telegram />)
  await screen.findByTestId('mffai-tg-status')
  await waitFor(() => expect(document.querySelector('[data-project-row]')).not.toBeNull())
}
const statusRow = () => within(screen.getByTestId('mffai-tg-status'))

beforeEach(() => {
  resetSeq()
  route.set({ page: 'conn' })
  spies = (['error', 'log', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => { vi.restoreAllMocks() })

describe('Telegram status', () => {
  it.each([
    ['starting', '启动中'], ['online', '在线'], ['reconnecting', '重连中'], ['unauthorized', '令牌无效'],
    ['conflict', '冲突'], ['no_token', '未设令牌'], ['disabled', '已停用'], ['secrets_unavailable', '凭据不可用'],
  ] as const)('state %s → %s', async (state, text) => {
    await mount(tgCalls(tgStatus({ state })))
    expect(statusRow().getByText(text)).toBeInTheDocument()
  })

  it('reason is a code chip; @bot, keychain, proxy, problems and 最后在线 are on the row', async () => {
    await mount(tgCalls(tgStatus({ state: 'reconnecting', reason: 'network_x', proxy: 'socks', problems: ['save_failed', 'odd_code'] })))
    const r = statusRow()
    expect(r.getByText('network_x').tagName).toBe('CODE')
    expect(r.getByText('@my_test_bot')).toBeInTheDocument()
    expect(r.getByText('钥匙串')).toBeInTheDocument()
    expect(r.getByText('SOCKS 代理')).toBeInTheDocument()
    expect(r.getByText('save_failed').tagName).toBe('CODE')
    expect(r.getByText('odd_code').tagName).toBe('CODE')
    expect(r.getByText(/^最后在线 /)).toBeInTheDocument()
  })

  it.each([
    ['plaintext-file', '明文存储'], ['unavailable', '钥匙串不可用'], ['unreadable', '钥匙串不可用'],
  ] as const)('secrets %s → %s', async (secretsBackend, text) => {
    await mount(tgCalls(tgStatus({ secretsBackend })))
    expect(statusRow().getByText(text)).toBeInTheDocument()
  })

  it.each([['none', '直连'], ['env', '环境代理']] as const)('proxy %s → %s', async (proxy, text) => {
    await mount(tgCalls(tgStatus({ proxy })))
    expect(statusRow().getByText(text)).toBeInTheDocument()
  })

  it('the dropped table: five labelled counts', async () => {
    await mount()
    const t = screen.getByRole('table')
    const heads = [...t.querySelectorAll('th')].map((h) => h.textContent)
    const cells = [...t.querySelectorAll('td')].map((c) => c.textContent)
    expect(heads).toEqual(['陌生人', '过期', '群', '附件', '坏消息'])
    expect(cells).toEqual(['1', '2', '3', '4', '5'])
  })

  it('未送达 N only when there is some', async () => {
    await mount()
    expect(screen.queryByText(/^未送达/)).toBeNull()
    f.script({ 'channel.telegram.status': tgStatus({ undelivered: 3 }) })
    act(() => { f.emit(ev('channel.status', { channel: 'telegram', state: 'online' })) })
    expect(await screen.findByText('未送达 3')).toBeInTheDocument()
  })

  it('清除 webhook only on conflict, and it calls clearWebhook with a commandId', async () => {
    await mount()
    expect(screen.queryByRole('button', { name: '清除 webhook' })).toBeNull()
    f.script({ 'channel.telegram.status': tgStatus({ state: 'conflict' }), 'channel.telegram.clearWebhook': { ok: true } })
    act(() => { f.emit(ev('channel.status', { channel: 'telegram', state: 'conflict' })) })
    const b = await screen.findByRole('button', { name: '清除 webhook' })
    act(() => { b.click(); b.click() })
    await waitFor(() => expect(f.callsOf('channel.telegram.clearWebhook')).toHaveLength(1))
    expect(typeof (f.callsOf('channel.telegram.clearWebhook')[0] as { commandId: unknown }).commandId).toBe('string')
  })

  it('status reloads on each channel.* event', async () => {
    await mount()
    const n = () => f.callsOf('channel.telegram.status').length
    const before = n()
    act(() => { f.emit(ev('channel.unpaired', { channel: 'telegram', accountId: '1', by: 'im' })) })
    await waitFor(() => expect(n()).toBe(before + 1))
    act(() => { f.emit(ev('channel.paired', { channel: 'telegram', accountId: '1', name: 'A' })) })
    await waitFor(() => expect(n()).toBe(before + 2))
  })

  it('-32601 on status → 不支持, nothing else', async () => {
    f = installFakeForge({ calls: { 'permissions.get': perms('full') } })
    render(<Telegram />)
    expect(await screen.findByText('不支持')).toBeInTheDocument()
    expect(screen.queryByLabelText('令牌')).toBeNull()
  })

  it('another status failure → 失败', async () => {
    f = installFakeForge({ calls: { ...tgCalls(), 'channel.telegram.status': () => fail(-32603, 'x') } })
    render(<Telegram />)
    expect(await screen.findByText('失败')).toBeInTheDocument()
  })
})

describe('Telegram token', () => {
  const leaks = () => {
    expect(document.body.innerHTML).not.toContain(TOKEN)
    for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toContain(TOKEN)
    for (const st of [localStorage, sessionStorage]) {
      for (let i = 0; i < st.length; i++) expect(`${st.key(i)}=${st.getItem(st.key(i)!)}`).not.toContain(TOKEN)
    }
  }

  it('save sends the token, then the input is empty and the token is nowhere; @username shows', async () => {
    await mount(tgCalls(tgStatus({ state: 'no_token', tokenSet: false, bot: undefined })))
    f.script({ 'channel.telegram.setToken': { ok: true, bot: { id: 2, username: 'fresh_bot' } } })
    const input = screen.getByLabelText<HTMLInputElement>('令牌')
    expect(input.type).toBe('password')
    fireEvent.change(input, { target: { value: TOKEN } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存令牌' })) })
    expect(f.callsOf('channel.telegram.setToken')).toEqual([{ token: TOKEN }])
    expect(input.value).toBe('')
    expect(await screen.findByText('@fresh_bot')).toBeInTheDocument()
    leaks()
  })

  it('a refusal keeps the input, shows the code, and logs no token', async () => {
    await mount(tgCalls(tgStatus({ tokenSet: false, bot: undefined })))
    f.script({ 'channel.telegram.setToken': () => fail(-32602, 'unauthorized') })
    const input = screen.getByLabelText<HTMLInputElement>('令牌')
    fireEvent.change(input, { target: { value: TOKEN } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存令牌' })) })
    expect(screen.getByText('unauthorized')).toBeInTheDocument()
    expect(input.value).toBe(TOKEN)
    // 输入框的值是属性,不是 DOM 文本
    leaks()
  })

  it('保存令牌 is disabled while empty; two clicks in one frame send once', async () => {
    await mount()
    f.script({ 'channel.telegram.setToken': () => new Promise<never>(() => {}) })
    const save = screen.getByRole('button', { name: '保存令牌' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('令牌'), { target: { value: TOKEN } })
    act(() => { save.click(); save.click() })
    expect(f.callsOf('channel.telegram.setToken')).toHaveLength(1)
  })

  it('清除令牌 goes through a confirm', async () => {
    await mount()
    f.script({ 'channel.telegram.clearToken': { ok: true } })
    fireEvent.click(screen.getByRole('button', { name: '清除令牌' }))
    const dlg = screen.getByRole('dialog')
    expect(within(dlg).getByText('@my_test_bot')).toBeInTheDocument()
    expect(f.callsOf('channel.telegram.clearToken')).toHaveLength(0)
    await act(async () => { fireEvent.click(dlg.querySelector('.confirm-danger')!) })
    expect(f.callsOf('channel.telegram.clearToken')).toEqual([{}])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('no token set → no 清除令牌', async () => {
    await mount(tgCalls(tgStatus({ tokenSet: false, bot: undefined })))
    expect(screen.queryByRole('button', { name: '清除令牌' })).toBeNull()
  })
})

describe('Telegram paired accounts', () => {
  it('each shows name and time; 撤销 confirms, then unpairs with a commandId', async () => {
    await mount(tgCalls(tgStatus({ paired: [{ accountId: '42', name: 'Ann', pairedAt: Date.now() - 1_000 }] })))
    f.script({ 'channel.telegram.unpair': { ok: true } })
    const row = screen.getByText('Ann').closest('.mffai-row') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '撤销' }))
    const dlg = screen.getByRole('dialog')
    expect(within(dlg).getByText('Ann')).toBeInTheDocument()
    expect(f.callsOf('channel.telegram.unpair')).toHaveLength(0)
    await act(async () => { fireEvent.click(dlg.querySelector('.confirm-danger')!) })
    const sent = f.callsOf('channel.telegram.unpair') as { commandId: string; accountId: string }[]
    expect(sent).toHaveLength(1)
    expect(sent[0].accountId).toBe('42')
    expect(typeof sent[0].commandId).toBe('string')
  })

  it('cancel in the confirm sends nothing', async () => {
    await mount(tgCalls(tgStatus({ paired: [{ accountId: '42', name: 'Ann', pairedAt: 1 }] })))
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }))
    expect(f.callsOf('channel.telegram.unpair')).toHaveLength(0)
  })
})

describe('Telegram config', () => {
  it('the 启用 switch saves the whole config with enabled flipped', async () => {
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: '启用' })) })
    expect((f.callsOf('channel.telegram.config.set')[0] as { config: unknown }).config).toEqual({ ...tgConfig(), enabled: false })
  })

  it('过期分钟 saves the whole config with the new number', async () => {
    await mount()
    fireEvent.change(screen.getByLabelText('过期分钟'), { target: { value: '25' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存分钟' })) })
    expect((f.callsOf('channel.telegram.config.set')[0] as { config: unknown }).config).toEqual({ ...tgConfig(), staleMinutes: 25 })
  })

  it('projects get the sandbox level from permissions.get', async () => {
    await mount({ ...tgCalls(), 'permissions.get': perms('partial') })
    await waitFor(() => expect(within(document.querySelector('[data-project-row]') as HTMLElement).getByText('部分')).toBeInTheDocument())
    expect(within(document.querySelector('[data-project-row]') as HTMLElement).getByRole('switch')).toBeDisabled()
  })
})

describe('Telegram chats', () => {
  it('rows show project, model, 排队 N and 运行中; the session opens the chat page', async () => {
    await mount({ ...tgCalls(), 'channel.telegram.chats': { chats: [
      { chatId: 'c1', accountId: '42', sessionId: 's1', project: 'api', model: { accountId: 'a1', modelId: 'gpt-x' }, queued: 2, running: true },
      { chatId: 'c2', accountId: '42', sessionId: 's2', queued: 0, running: false },
    ], worktrees: [] } })
    const rows = await screen.findAllByTestId('mffai-tg-chat')
    expect(rows).toHaveLength(2)
    const r0 = within(rows[0])
    expect(r0.getByText('api')).toBeInTheDocument()
    expect(r0.getByText('gpt-x')).toBeInTheDocument()
    expect(r0.getByText('排队 2')).toBeInTheDocument()
    expect(r0.getByText('运行中')).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/^排队/)).toBeNull()
    expect(within(rows[1]).queryByText('运行中')).toBeNull()
    fireEvent.click(r0.getByRole('button', { name: 's1' }))
    expect(route.get()).toEqual({ page: 'chat', sessionId: 's1' })
  })
})
