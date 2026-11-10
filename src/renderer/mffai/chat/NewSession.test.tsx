import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { NewSession } from './NewSession'
import ChatPage from './ChatPage'
import { route } from '../route'
import { ev } from '../test/events'
import { AUTO_LABEL } from '../ui/AutoSwitch'
import { fail, installFakeForge, type CallTable } from '../test/fakeForge'
import { perms, summary } from '../test/sessions'

const model = (id: string) => ({ id, name: id.toUpperCase(), context: 1, output: 1, image: false, reasoning: 'none' as const, toolCall: true })
const presets = [{ id: 'p', label: 'Key', billing: 'metered', restriction: 'none', auth: 'api-key', protocols: [], docsUrl: '' }]

function setup(opts: { accounts?: boolean; calls?: CallTable } = {}) {
  const f = installFakeForge({ calls: { 'permissions.get': perms('full'), 'session.create': { sessionId: 's9' }, ...opts.calls } })
  f.mffai.models.catalog = vi.fn(async () => ({ presets, models: { p: [model('m1')] }, default: { accountId: 'a1', modelId: 'm1' } }))
  f.mffai.models.accounts = vi.fn(async () => ({ accounts: opts.accounts === false ? [] : [{ id: 'a1', presetId: 'p', label: 'acc', state: 'ok' }], secretsBackend: 'keychain' }))
  return f
}
const cwdInput = () => screen.getByRole('textbox', { name: '工作目录' })
const start = () => screen.getByRole('button', { name: '开始' }) as HTMLButtonElement

describe('NewSession', () => {
  it('no accounts: AddAccount takes the model slot and 开始 is disabled', async () => {
    setup({ accounts: false })
    const { container } = render(<NewSession onCreated={() => {}} />)
    expect(await screen.findByText('添加账号')).toBeInTheDocument()
    expect(container.querySelector('.mffai-picker')).toBeNull()
    expect(start().disabled).toBe(true)
  })

  it('toolset and AutoSwitch appear only with a cwd; the AutoSwitch label is the spec sentence', async () => {
    setup()
    const { container } = render(<NewSession onCreated={() => {}} />)
    await waitFor(() => expect((container.querySelector('.mffai-picker') as HTMLSelectElement)?.value).toBeTruthy())
    expect(screen.queryByRole('combobox', { name: '编辑工具' })).toBeNull()
    expect(container.querySelector('.mffai-switch')).toBeNull()
    expect(cwdInput().getAttribute('placeholder')).toBeNull()
    fireEvent.change(cwdInput(), { target: { value: '/repo' } })
    const tools = screen.getByRole('combobox', { name: '编辑工具' }) as HTMLSelectElement
    expect([...tools.options].map((o) => o.textContent)).toEqual(['自动', 'apply_patch', 'edit'])
    expect(container.querySelector('.mffai-switch label, label.mffai-switch')!.textContent).toBe(AUTO_LABEL)
    fireEvent.change(cwdInput(), { target: { value: '  ' } })
    expect(screen.queryByRole('combobox', { name: '编辑工具' })).toBeNull()
  })

  it('需审批 beside the switch on level none with allowUnsandboxedAuto off only', async () => {
    for (const [p, shown] of [[perms('none'), true], [perms('none', true), false], [perms('partial'), false]] as const) {
      setup({ calls: { 'permissions.get': p } })
      const { unmount } = render(<NewSession onCreated={() => {}} initial={{ cwd: '/repo' }} />)
      await screen.findByText(AUTO_LABEL)
      if (shown) expect(await screen.findByText('需审批')).toBeInTheDocument()
      else {
        await waitFor(() => expect(document.querySelector('.mffai-switch')).not.toBeNull())
        await act(async () => {})
        expect(screen.queryByText('需审批')).toBeNull()
      }
      unmount()
    }
  })

  it('开始 sends session.create with model, cwd, approvalMode and toolset, never origin; then onCreated', async () => {
    const f = setup()
    const onCreated = vi.fn()
    render(<NewSession onCreated={onCreated} />)
    await waitFor(() => expect(start().disabled).toBe(false))
    fireEvent.change(cwdInput(), { target: { value: ' /repo ' } })
    fireEvent.change(screen.getByRole('combobox', { name: '编辑工具' }), { target: { value: 'patch' } })
    fireEvent.click(screen.getByRole('switch'))
    await act(async () => { fireEvent.click(start()) })
    const [p] = f.callsOf('session.create') as any[]
    expect(p).toEqual({ commandId: expect.any(String), model: { accountId: 'a1', modelId: 'm1' }, cwd: '/repo', approvalMode: 'auto', toolset: 'patch' })
    expect('origin' in p).toBe(false)
    expect(onCreated).toHaveBeenCalledWith('s9')
  })

  it('no cwd: no cwd, approvalMode or toolset keys', async () => {
    const f = setup()
    render(<NewSession onCreated={() => {}} />)
    await waitFor(() => expect(start().disabled).toBe(false))
    await act(async () => { fireEvent.click(start()) })
    expect(f.callsOf('session.create')).toEqual([{ commandId: expect.any(String), model: { accountId: 'a1', modelId: 'm1' } }])
  })

  it('initial cwd prefills; 自动 sends no toolset and the switch off sends ask', async () => {
    const f = setup()
    render(<NewSession onCreated={() => {}} initial={{ cwd: '/pre' }} />)
    expect((cwdInput() as HTMLInputElement).value).toBe('/pre')
    await waitFor(() => expect(start().disabled).toBe(false))
    await act(async () => { fireEvent.click(start()) })
    expect(f.callsOf('session.create')).toEqual([{ commandId: expect.any(String), model: { accountId: 'a1', modelId: 'm1' }, cwd: '/pre', approvalMode: 'ask' }])
  })

  it('a failed create shows 失败; the retry reuses the commandId', async () => {
    let n = 0
    const f = setup({ calls: { 'session.create': () => (++n === 1 ? fail(-32010, 'timeout') : { sessionId: 's9' }) } })
    const onCreated = vi.fn()
    render(<NewSession onCreated={onCreated} />)
    await waitFor(() => expect(start().disabled).toBe(false))
    await act(async () => { fireEvent.click(start()) })
    expect(await screen.findByText('失败')).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(start()) })
    const [a, b] = f.callsOf('session.create') as any[]
    expect(b.commandId).toBe(a.commandId)
    expect(onCreated).toHaveBeenCalledWith('s9')
  })
  it('08b: the 新对话 title row with the brand tile, the form as a panel, 开始 kept', async () => {
    setup()
    const { container } = render(<NewSession onCreated={() => {}} initial={{ cwd: '/repo' }} />)
    const head = container.querySelector('.mffai-newhead')!
    expect(head.textContent).toBe('新对话')
    expect(head.querySelector('.mffai-brandtile svg')).not.toBeNull()
    const form = container.querySelector('.mffai-newsess')!
    expect(form.classList.contains('mffai-form')).toBe(true)
    expect([...form.querySelectorAll('.mffai-k')].map((k) => k.textContent)).toEqual(['模型', '工作目录', '编辑工具', '审批'])
    expect(head.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(form as HTMLElement).getByRole('button', { name: '开始' })).toBeInTheDocument()
    expect(within(form as HTMLElement).getByRole('button', { name: '选择' })).toBeInTheDocument()
    // Review Focus 7:开关标签逐字
    const sw = await waitFor(() => { const l = form.querySelector('label.mffai-switch.mffai-warnrow'); expect(l).not.toBeNull(); return l! })
    expect(sw.textContent).toBe(AUTO_LABEL)
    expect(sw.querySelector('input[type=checkbox][role=switch]')).not.toBeNull()
  })
  it('08b: RecommendationCard sits above the form on the start page (title first via CSS order) and at the top of the conversation column with a session open', async () => {
    const f = setup({ calls: {
      'session.list': { sessions: [summary('a', { title: '本机会话' })] },
      'session.state': { session: summary('a'), events: [], hasMore: false, lastSeq: 0 },
      'plugins.commands': { commands: [] }, 'executor.runs': { runs: [] },
    } })
    route.set({ page: 'chat' })
    render(<ChatPage />)
    await screen.findByRole('button', { name: '开始' })
    act(() => { f.emit(ev('memory.recommendation', { id: 'r1', category: 'routine', habitId: 'h1', text: '每周一常在 repo 工作', cwd: '/repo' })) })
    await screen.findByText('每周一常在 repo 工作')
    const main = () => document.querySelector('.mffai-chat-main')!
    const kids = () => [...main().children].map((c) => c.className.split(' ')[0])
    expect(kids()).toEqual(['mffai-recs', 'mffai-newhead', 'mffai-card'])
    const css = readFileSync(resolve(__dirname, '../styles/chat.css'), 'utf8')
    expect(css).toMatch(/\.mffai-chat-new\s*>\s*\.mffai-newhead\s*\{[^}]*order:\s*-1/)
    act(() => route.set({ page: 'chat', sessionId: 'a' }))
    await waitFor(() => expect(document.querySelector('.mffai-convo')).not.toBeNull())
    expect(kids()).toEqual(['mffai-recs', 'mffai-convo'])
    expect(css).toMatch(/\.mffai-recs\s*\{[^}]*grid-column:\s*1;\s*grid-row:\s*1/)
  })
})
