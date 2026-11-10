import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SessionSummary } from '@mffai/protocol'
import { SessionColumn } from './SessionColumn'
import ChatPage from './ChatPage'
import { MainWidthProvider } from '../useMainWidth'
import { route } from '../route'
import { installResize } from '../test/resize'
import { installFakeForge, type FakeForge } from '../test/fakeForge'
import { resetSeq } from '../test/events'
import { perms, summary } from '../test/sessions'

const titles = () => [...document.querySelectorAll('.mffai-sess')].map((r) => r.querySelector('.mffai-sess-title')!.textContent)
const rowOf = (title: string) => [...document.querySelectorAll('.mffai-sess')].find((r) => r.querySelector('.mffai-sess-title')?.textContent === title) as HTMLElement
const col = () => document.querySelector('aside.mffai-sesscol') as HTMLElement
const seg = (name: string) => within(col()).getByRole('button', { name }) as HTMLButtonElement

const SESSIONS = (): SessionSummary[] => [
  summary('a', { title: '本机', cwd: '~/work/forge-api', updatedAt: 6, pendingApprovals: 2, open: { turnId: 't', parked: false } }),
  summary('b', { title: '手机', origin: 'im', audience: 'group', updatedAt: 5, open: { turnId: 't', parked: true } }),
  summary('c', { title: '编辑器', origin: 'acp', updatedAt: 4 }),
  summary('d', { title: '定时', origin: 'schedule', updatedAt: 3 }),
  { ...summary('e', { title: '寻呼', updatedAt: 2 }), origin: 'pager' as never },
  summary('f', { title: '另一个本机', updatedAt: 1 }),
]

function mount(p: Partial<Parameters<typeof SessionColumn>[0]> = {}) {
  const props = {
    sessions: SESSIONS(),
    active: 'a',
    imNames: new Map([['b', 'Alice']]),
    unsupported: false,
    narrow: false,
    onNew: vi.fn(), onSelect: vi.fn(), onRename: vi.fn(async () => true), onDelete: vi.fn(),
    ...p,
  }
  const r = render(<SessionColumn {...props} />)
  return { props, ...r }
}

beforeEach(() => { resetSeq(); route.set({ page: 'chat' }) })

describe('SessionColumn', () => {
  it('aside.mffai-sesscol: 新会话 first, then the origin filter, then the list', () => {
    const { props } = mount()
    expect(col()).not.toBeNull()
    expect(col().classList.contains('narrow')).toBe(false)
    const btn = within(col()).getByRole('button', { name: '新会话' })
    fireEvent.click(btn)
    expect(props.onNew).toHaveBeenCalledTimes(1)
    const group = within(col()).getByRole('group', { name: '来源' })
    expect(within(group).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['全部', '本机', 'Telegram', '定时'])
    // 全部是字,其余三个是图标:列表里的 本机 / 定时 文字不会和筛选撞
    expect(within(group).queryByText('本机')).toBeNull()
    expect(seg('全部').getAttribute('aria-pressed')).toBe('true')
    expect(titles()).toEqual(['本机', '手机', '编辑器', '定时', '寻呼', '另一个本机'])
  })

  it('the filter: 本机 = app, Telegram = im, 定时 = schedule and unknown origins, 全部 = all', () => {
    mount()
    fireEvent.click(seg('Telegram'))
    expect(titles()).toEqual(['手机'])
    expect(seg('Telegram').getAttribute('aria-pressed')).toBe('true')
    expect(seg('全部').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(seg('本机'))
    expect(titles()).toEqual(['本机', '另一个本机'])
    fireEvent.click(seg('定时'))
    expect(titles()).toEqual(['定时', '寻呼'])
    fireEvent.click(seg('全部'))
    expect(titles()).toHaveLength(6)
  })

  it('the filter is local: a new list keeps it, a remount starts at 全部', () => {
    const { props, rerender, unmount } = mount()
    fireEvent.click(seg('Telegram'))
    rerender(<SessionColumn {...props} sessions={[...SESSIONS(), summary('g', { title: '又一个', origin: 'im', updatedAt: 0 })]} />)
    expect(titles()).toEqual(['手机', '又一个'])
    unmount()
    mount()
    expect(seg('全部').getAttribute('aria-pressed')).toBe('true')
    expect(titles()).toHaveLength(6)
  })

  it('rows: origin tile, title, a second line (cwd / Telegram + name / 群聊 / 挂起), spinner or time, the pending dot', () => {
    mount()
    const a = rowOf('本机')
    expect(a.querySelector('.mffai-origin')!.getAttribute('data-origin')).toBe('app')
    expect(a.querySelector('.mffai-sess-sub')!.textContent).toBe('~/work/forge-api')
    // 运行中:右侧是转圈,不是时间
    expect(a.querySelector('.mffai-sess-right .mffai-spin')).not.toBeNull()
    expect(within(a).getByText('运行中')).toBeInTheDocument()
    expect(a.querySelector('.mffai-sess-time')).toBeNull()
    expect(a.querySelector('.mffai-sess-dot')!.textContent).toBe('2')

    const b = rowOf('手机')
    const sub = b.querySelector('.mffai-sess-sub') as HTMLElement
    expect(within(sub).getByText('Alice')).toBeInTheDocument()
    expect(within(sub).getByText('群聊')).toBeInTheDocument()
    expect(within(sub).getByText('挂起')).toBeInTheDocument()
    expect(sub.textContent).toContain('Telegram')
    // 挂起不算在跑:右侧是时间
    expect(b.querySelector('.mffai-sess-time')).not.toBeNull()
    expect(b.querySelector('.mffai-sess-right .mffai-spin')).toBeNull()
    expect(b.querySelector('.mffai-sess-dot')).toBeNull()
  })

  it('narrow: aside gets .narrow; the second line, the Telegram name and 群聊 stay in the DOM', () => {
    mount({ narrow: true })
    expect(col().classList.contains('narrow')).toBe(true)
    const b = rowOf('手机')
    expect(b.querySelector('.mffai-sess-sub')).not.toBeNull()
    expect(within(b).getByText('Alice')).toBeInTheDocument()
    expect(within(b).getByText('群聊')).toBeInTheDocument()
  })

  it('narrow: the filter button opens the same seg as a popover; picking one closes it; Esc closes it', () => {
    mount({ narrow: true })
    const filter = within(col()).getByRole('button', { name: '筛选' })
    expect(filter.getAttribute('aria-expanded')).toBe('false')
    const group = within(col()).getByRole('group', { name: '来源' })
    expect(group.classList.contains('open')).toBe(false)
    fireEvent.click(filter)
    expect(filter.getAttribute('aria-expanded')).toBe('true')
    expect(group.classList.contains('open')).toBe(true)
    // 同一组按钮,不是复制一份
    expect(within(col()).getAllByRole('button', { name: 'Telegram' })).toHaveLength(1)
    fireEvent.click(seg('Telegram'))
    expect(titles()).toEqual(['手机'])
    expect(group.classList.contains('open')).toBe(false)
    expect(filter.classList.contains('on')).toBe(true)
    fireEvent.click(filter)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(group.classList.contains('open')).toBe(false)
    expect(document.activeElement).toBe(filter)
  })

  it('narrow: an outside click closes the popover', () => {
    mount({ narrow: true })
    fireEvent.click(within(col()).getByRole('button', { name: '筛选' }))
    const group = within(col()).getByRole('group', { name: '来源' })
    expect(group.classList.contains('open')).toBe(true)
    fireEvent.mouseDown(document.body)
    expect(group.classList.contains('open')).toBe(false)
  })

  it('wide: no filter button', () => {
    mount()
    expect(within(col()).queryByRole('button', { name: '筛选' })).toBeNull()
  })

  it('unsupported: 不支持 instead of the list', () => {
    mount({ unsupported: true })
    expect(within(col()).getByText('不支持')).toBeInTheDocument()
    expect(document.querySelector('.mffai-sesslist')).toBeNull()
  })
})

describe('SessionList groups', () => {
  afterEach(() => { vi.useRealTimers() })

  it('今天 / 昨天 / 更早 heads from updatedAt, newest first; heads are not options', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date(2026, 10, 10, 15, 0).getTime()
    vi.setSystemTime(now)
    const at = (d: number, h: number) => new Date(2026, 10, 10 - d, h, 0).getTime()
    mount({ sessions: [
      summary('t1', { title: '今早', updatedAt: at(0, 9) }),
      summary('y1', { title: '昨晚', updatedAt: at(1, 23) }),
      summary('t2', { title: '刚才', updatedAt: at(0, 14) }),
      summary('o1', { title: '上周', updatedAt: at(7, 10) }),
      summary('y2', { title: '昨早', updatedAt: at(1, 0) }),
    ] })
    const list = document.querySelector('.mffai-sesslist')!
    const seq = [...list.children].map((li) => li.classList.contains('mffai-sessgh') ? `#${li.textContent}` : li.querySelector('.mffai-sess-title')!.textContent)
    expect(seq).toEqual(['#今天', '刚才', '今早', '#昨天', '昨晚', '昨早', '#更早', '上周'])
    expect(within(list as HTMLElement).getAllByRole('option')).toHaveLength(5)
    for (const h of list.querySelectorAll('.mffai-sessgh')) expect(h.getAttribute('role')).toBe('presentation')
  })

  it('an empty group has no head', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 10, 15, 0).getTime())
    mount({ sessions: [summary('o', { title: 'old', updatedAt: 5 })] })
    expect([...document.querySelectorAll('.mffai-sessgh')].map((h) => h.textContent)).toEqual(['更早'])
  })
})

describe('ChatPage with the session column', () => {
  let f: FakeForge
  let uninstall: (() => void) | undefined
  afterEach(() => { uninstall?.(); uninstall = undefined })

  function setup() {
    f = installFakeForge({ calls: {
      'session.list': { sessions: [
        summary('a', { title: '本机会话', updatedAt: 5 }),
        summary('im', { title: '手机', origin: 'im', audience: 'group', updatedAt: 4 }),
        summary('s', { title: '巡检', origin: 'schedule', updatedAt: 3 }),
      ] },
      'channel.telegram.chats': { chats: [{ chatId: '7', accountId: '7', sessionId: 'im', queued: 0, running: false }], worktrees: [] },
      'channel.telegram.status': { state: 'online', enabled: true, tokenSet: true, secretsBackend: 'keychain', proxy: 'none', paired: [{ accountId: '7', name: 'Bob', pairedAt: 1 }], pairing: { active: false }, dropped: { unpaired: 0, stale: 0, group: 0, attachment: 0, badUpdate: 0 }, undelivered: 0, problems: [] },
      'permissions.get': perms('full'),
      'executor.runs': { runs: [] },
    } })
  }

  it('新会话 routes newSession: {} as today', async () => {
    setup()
    route.set({ page: 'chat', sessionId: 'a' })
    render(<ChatPage />)
    await waitFor(() => expect(rowOf('本机会话')).toBeTruthy())
    fireEvent.click(within(col()).getByRole('button', { name: '新会话' }))
    expect(route.get()).toEqual({ page: 'chat', newSession: {} })
  })

  it('width: no ResizeObserver → wide; 1199 → narrow; 1200 → wide', async () => {
    setup()
    const first = render(<MainWidthProvider><ChatPage /></MainWidthProvider>)
    await waitFor(() => expect(rowOf('手机')).toBeTruthy())
    expect(col().classList.contains('narrow')).toBe(false)
    first.unmount()

    const r = installResize()
    uninstall = r.uninstall
    render(<MainWidthProvider><ChatPage /></MainWidthProvider>)
    await waitFor(() => expect(rowOf('手机')).toBeTruthy())
    r.setMainWidth(1199)
    expect(col().classList.contains('narrow')).toBe(true)
    // 窄:副行、Telegram 名字、群聊还在 DOM 里(只用 CSS 藏)
    await waitFor(() => expect(within(rowOf('手机')).getByText('Bob')).toBeInTheDocument())
    expect(within(rowOf('手机')).getByText('群聊')).toBeInTheDocument()
    expect(rowOf('手机').querySelector('.mffai-sess-sub')).not.toBeNull()
    r.setMainWidth(1200)
    expect(col().classList.contains('narrow')).toBe(false)
  })

  it('the origin filter never calls session.list again', async () => {
    setup()
    render(<ChatPage />)
    await waitFor(() => expect(rowOf('巡检')).toBeTruthy())
    const lists = f.callsOf('session.list').length
    fireEvent.click(seg('Telegram'))
    expect(titles()).toEqual(['手机'])
    fireEvent.click(seg('定时'))
    expect(titles()).toEqual(['巡检'])
    fireEvent.click(seg('本机'))
    expect(titles()).toEqual(['本机会话'])
    fireEvent.click(seg('全部'))
    expect(titles()).toHaveLength(3)
    await act(async () => { await new Promise((r) => setTimeout(r, 350)) })
    expect(f.callsOf('session.list')).toHaveLength(lists)
  })
})
