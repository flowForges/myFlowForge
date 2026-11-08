// 配对码(08 §10.3、Review Focus 8):进行中看得见;channel.paired、channel.pairing.burned、到期、取消、卸载后
// DOM 里没有它(二维码的 aria-label 和路径也不带它),也不进 console、localStorage、sessionStorage。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Pairing } from './Pairing'
import { installFakeForge, fail, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'

// 运行时拼出来:源码里不出现一个像真码的字面量
const CODE = ['K7Q2', 'XM9P'].join('-')
const RAW = CODE.replace('-', '')
const LINK = `https://t.me/my_test_bot?start=${RAW}`
const NOW = 1_800_000_000_000

let f: FakeForge
let spies: ReturnType<typeof vi.spyOn>[]

function begin(link: string | null = LINK, ttl = 300_000) {
  return { 'channel.telegram.pairing.begin': () => ({ code: CODE, expiresAt: Date.now() + ttl, ...(link !== null && { link }) }), 'channel.telegram.pairing.cancel': { ok: true } }
}

function absent() {
  const html = document.body.innerHTML
  expect(html).not.toContain(CODE)
  expect(html).not.toContain(RAW)
  expect(document.querySelector('svg.qr')).toBeNull()
  for (const s of spies) for (const c of s.mock.calls) expect(JSON.stringify(c)).not.toContain(RAW)
  for (const st of [localStorage, sessionStorage]) {
    for (let i = 0; i < st.length; i++) expect(`${st.key(i)}=${st.getItem(st.key(i)!)}`).not.toContain(RAW)
  }
}

async function start() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始配对' })) })
  expect(await screen.findByText(CODE)).toBeInTheDocument()
}

beforeEach(() => {
  resetSeq()
  spies = (['error', 'log', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('Pairing', () => {
  it('shows the code, a countdown, the link button and a QR of the link', async () => {
    f = installFakeForge({ calls: begin() })
    render(<Pairing active={false} />)
    await start()
    expect(f.callsOf('channel.telegram.pairing.begin')).toEqual([{}])
    expect(document.querySelector('.mffai-count')?.textContent).toMatch(/^[45]:\d\d$/)
    const qr = document.querySelector('svg.qr')!
    expect(qr).not.toBeNull()
    // 二维码的名字不带码
    expect(qr.getAttribute('aria-label')).not.toContain(RAW)
    fireEvent.click(screen.getByRole('button', { name: '打开链接' }))
    expect(f.mffai.openExternal).toHaveBeenCalledWith(LINK)
    expect(f.forge.openExternal).not.toHaveBeenCalled()
  })

  it('a link not in the t.me pairing shape gets no button and no QR', async () => {
    f = installFakeForge({ calls: begin(`https://evil.example/?start=${RAW}`) })
    render(<Pairing active={false} />)
    await start()
    expect(screen.queryByRole('button', { name: '打开链接' })).toBeNull()
    expect(document.querySelector('svg.qr')).toBeNull()
  })

  it('no link (bot name unknown): code and countdown only', async () => {
    f = installFakeForge({ calls: begin(null) })
    render(<Pairing active={false} />)
    await start()
    expect(screen.queryByRole('button', { name: '打开链接' })).toBeNull()
    expect(document.querySelector('svg.qr')).toBeNull()
  })

  it('channel.paired clears it', async () => {
    f = installFakeForge({ calls: begin() })
    render(<Pairing active={false} />)
    await start()
    act(() => { f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })) })
    absent()
    expect(screen.getByRole('button', { name: '开始配对' })).toBeInTheDocument()
  })

  it('channel.pairing.burned clears it', async () => {
    f = installFakeForge({ calls: begin() })
    render(<Pairing active={false} />)
    await start()
    act(() => { f.emit(ev('channel.pairing.burned', { channel: 'telegram' })) })
    absent()
  })

  it('expiry clears it (fake timers)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    f = installFakeForge({ calls: begin(LINK, 10_000) })
    render(<Pairing active={false} />)
    await start()
    act(() => { vi.advanceTimersByTime(11_000) })
    absent()
  })

  it('expiry tells the parent, so a stale 配对中 is refetched away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    f = installFakeForge({ calls: begin(LINK, 10_000) })
    const onChanged = vi.fn()
    render(<Pairing active={false} onChanged={onChanged} />)
    await start()
    const n = onChanged.mock.calls.length
    act(() => { vi.advanceTimersByTime(11_000) })
    expect(onChanged.mock.calls.length).toBe(n + 1)
  })

  it.each(['channel.telegram.pairing.begin', 'channel.telegram.pairing.cancel'] as const)('-32601 from %s → 不支持', async (method) => {
    f = installFakeForge({ calls: { 'channel.telegram.pairing.begin': () => fail(-32601, 'method not found') } })
    render(<Pairing active={method === 'channel.telegram.pairing.cancel'} />)
    const name = method === 'channel.telegram.pairing.begin' ? '开始配对' : '取消'
    await act(async () => { fireEvent.click(screen.getByRole('button', { name })) })
    expect(screen.getByText('不支持')).toBeInTheDocument()
  })

  it('cancel clears it at once and calls pairing.cancel', async () => {
    f = installFakeForge({ calls: { ...begin(), 'channel.telegram.pairing.cancel': () => new Promise<never>(() => {}) } })
    render(<Pairing active={false} />)
    await start()
    act(() => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    absent()
    expect(f.callsOf('channel.telegram.pairing.cancel')).toEqual([{}])
  })

  it('unmount clears it and cancels the code this component issued', async () => {
    f = installFakeForge({ calls: begin() })
    const { unmount } = render(<Pairing active={false} />)
    await start()
    unmount()
    absent()
    expect(f.callsOf('channel.telegram.pairing.cancel')).toEqual([{}])
  })

  it('unmount without a local code cancels nothing (a pairing begun elsewhere is left alone)', async () => {
    f = installFakeForge({ calls: begin() })
    const { unmount } = render(<Pairing active />)
    unmount()
    expect(f.callsOf('channel.telegram.pairing.cancel')).toEqual([])
  })

  it('unmount after the code already cleared (paired) cancels nothing', async () => {
    f = installFakeForge({ calls: begin() })
    const { unmount } = render(<Pairing active={false} />)
    await start()
    act(() => { f.emit(ev('channel.paired', { channel: 'telegram', accountId: '42', name: 'Ann' })) })
    unmount()
    expect(f.callsOf('channel.telegram.pairing.cancel')).toEqual([])
  })

  it('a begin answer arriving after unmount is dropped', async () => {
    let resolve!: (v: { code: string; expiresAt: number; link: string }) => void
    f = installFakeForge({ calls: { 'channel.telegram.pairing.begin': () => new Promise((r) => { resolve = r }), 'channel.telegram.pairing.cancel': { ok: true } } })
    const { unmount } = render(<Pairing active={false} />)
    fireEvent.click(screen.getByRole('button', { name: '开始配对' }))
    unmount()
    await act(async () => { resolve({ code: CODE, expiresAt: Date.now() + 1000, link: LINK }) })
    absent()
    expect(f.callsOf('channel.telegram.pairing.cancel')).toEqual([{}])
  })

  it('active elsewhere without a local code: 配对中 and 取消, no code', async () => {
    f = installFakeForge({ calls: begin() })
    render(<Pairing active />)
    expect(screen.getByText('配对中')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(f.callsOf('channel.telegram.pairing.cancel')).toEqual([{}]))
  })

  it('a refusal shows its code; other errors 失败; nothing logged holds a code', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.pairing.begin': () => fail(-32602, 'no_token') } })
    render(<Pairing active={false} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始配对' })) })
    expect(await screen.findByText('no_token')).toBeInTheDocument()
    f.script({ 'channel.telegram.pairing.begin': () => fail(-32603, 'boom') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '开始配对' })) })
    expect(await screen.findByText('失败')).toBeInTheDocument()
  })

  it('two clicks in one frame begin once', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.pairing.begin': () => new Promise<never>(() => {}) } })
    render(<Pairing active={false} />)
    const b = screen.getByRole('button', { name: '开始配对' })
    act(() => { b.click(); b.click() })
    expect(f.callsOf('channel.telegram.pairing.begin')).toHaveLength(1)
  })
})
