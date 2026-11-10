// 权限页(08 §11、Review Focus 7、评审修订):本地草稿(规则、联网名单、三个开关)是全局的——会话选择器只
// 重取它实际管的默认规则和沙箱状态(kernel.ts 575-579:config 不按会话),从不碰草稿,也配一个序号守卫
// (快速切换只认最后一次)。规则按稳定 id 操作和标错,不按下标。联网名单的 reason:'network' 错误按下标标在
// 联网名单上,不落到规则行。保存前把每个标签框里还没点「添加」的文字强制收进来。保存中所有控件锁住,
// 这条保存自己产生的 permissions.updated 不理会(不闪烁「已在别处修改」);重置按同一条脏检查。
// permissions.get 在加载时丢掉的条目(errors)作为代码块显示,带原文。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PermissionsConfig, RuleSpec, SandboxStatus } from '@mffai/protocol'
import PermissionsPage from './PermissionsPage'
import { HeaderSlotCtx } from '../shell/headerSlot'
import { UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { fail, installFakeForge, type CallTable, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { summary } from '../test/sessions'

let f: FakeForge
let slot: HTMLElement
// 会话选择器经 HeaderExtra 搬到页头:测试给一个挂载点
const renderPage = () => render(<HeaderSlotCtx.Provider value={slot}><PermissionsPage /></HeaderSlotCtx.Provider>)

const baseConfig = (patch: Partial<PermissionsConfig> = {}): PermissionsConfig => ({
  rules: [{ effect: 'ask', rule: 'shell(git status)', match: ['git status'], noMatch: [] }],
  network: { allow: ['example.com'] },
  sandbox: { enabled: true, allowLoopback: false },
  allowUnsandboxedAuto: false,
  ...patch,
})
const getResult = (
  configPatch: Partial<PermissionsConfig> = {},
  sandbox: SandboxStatus = { level: 'partial', missing: ['proxy'], autoDegraded: false },
  loadErrors: { index: number; rule: string; reason: 'syntax' | 'subject' | 'pattern' | 'test_failed' | 'network'; case?: string }[] = [],
) => ({ config: baseConfig(configPatch), defaults: ['shell:read'], errors: loadErrors, sandbox })

const rule = (text: string, patch: Partial<RuleSpec> = {}): RuleSpec => ({ effect: 'ask', rule: text, match: [], noMatch: [], ...patch })
const rows = () => [...document.querySelectorAll('[data-rule]')] as HTMLElement[]

async function mount(calls: CallTable = { 'permissions.get': getResult() }) {
  f = installFakeForge({ calls })
  renderPage()
  await screen.findByRole('switch', { name: '沙箱' })
}

beforeEach(() => {
  resetSeq()
  slot = document.createElement('div')
  document.body.append(slot)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); slot.remove() })

describe('PermissionsPage', () => {
  it('loads the draft: rule row, network tag, switches and sandbox chips', async () => {
    await mount()
    expect(rows()).toHaveLength(1)
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell(git status)')
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText('shell:read')).toBeInTheDocument()
    expect(screen.getByText('proxy')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('shows the sandbox level and every missing code as its own chip; none renders 未隔离', async () => {
    await mount({ 'permissions.get': getResult({}, { level: 'none', missing: ['sandbox-exec', 'proxy'], autoDegraded: true }) })
    expect(screen.getByText('未隔离')).toBeInTheDocument()
    expect(screen.getByText('sandbox-exec')).toBeInTheDocument()
    expect(screen.getByText('proxy')).toBeInTheDocument()
  })

  it('defaults render as a read-only list: no inputs or buttons inside', async () => {
    await mount()
    const defaults = screen.getByTestId('mffai-perm-defaults')
    expect(within(defaults).getByText('shell:read')).toBeInTheDocument()
    expect(within(defaults).queryByRole('button')).toBeNull()
    expect(within(defaults).queryByRole('textbox')).toBeNull()
  })

  it('shows errors dropped at load (permissions.get().errors) as chips with their entry text', async () => {
    await mount({ 'permissions.get': getResult({}, undefined, [{ index: 0, rule: 'shell(bad', reason: 'syntax' }]) })
    expect(screen.getByText('syntax')).toBeInTheDocument()
    expect(screen.getByText('shell(bad')).toBeInTheDocument()
  })

  it('puts the session selector in the page header slot; the editable section is titled 全局规则', async () => {
    await mount()
    const heads = [...document.querySelectorAll('.mffai-grouphead')].map((h) => h.textContent)
    expect(heads.some((h) => h?.startsWith('默认规则'))).toBe(true)
    expect(heads.some((h) => h?.startsWith('全局规则'))).toBe(true)
    expect(within(slot).getByLabelText('会话')).toBeInTheDocument()
    const defaultsBlock = screen.getByTestId('mffai-perm-defaults').closest('.mffai-card') as HTMLElement
    expect(within(defaultsBlock).queryByLabelText('会话')).toBeNull()
  })

  it('the save bar is absent while clean, appears with 未保存 after an edit, and is disabled while the save is in flight', async () => {
    let resolveSet: ((v: { ok: boolean }) => void) | undefined
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => new Promise((resolve) => { resolveSet = resolve }) })
    expect(screen.queryByText('未保存')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '允许本机回环' }))
    expect(screen.getByText('未保存')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
    expect(f.callsOf('permissions.set')).toHaveLength(1)
    await act(async () => { resolveSet!({ ok: true }) })
    await waitFor(() => expect(screen.queryByText('未保存')).toBeNull())
  })

  it('a conflict shows the 已在别处修改 text and a 重新载入 button in the bar; the save bar is hidden meanwhile', async () => {
    await mount()
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'changed' } })
    act(() => { f.emit(ev('permissions.updated', { rules: 2, network: 1 })) })
    const bar = (await screen.findByText('已在别处修改')).closest('.mffai-conflict') as HTMLElement
    expect(within(bar).getByText('重新载入')).toBeInTheDocument()
    expect(screen.queryByText('未保存')).toBeNull()
  })

  it('an erroring rule row is tinted and shows test_failed with its failing case inline in the row', async () => {
    await mount({
      'permissions.get': getResult(),
      'permissions.set': () => fail(-32602, 'invalid', [{ index: 0, rule: 'shell(git status)', reason: 'test_failed', case: 'git push' }]),
    })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(x)' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    await screen.findByText('git push')
    expect(rows()[0]).toHaveClass('mffai-rule-bad')
    expect(within(rows()[0]).getByText('git push')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('the three switches: 沙箱, 允许本机回环, and allowUnsandboxedAuto with the sanctioned label verbatim', async () => {
    await mount()
    expect(await screen.findByText(UNSANDBOXED_AUTO_LABEL)).toBeInTheDocument()
    const sandboxSwitch = screen.getByRole('switch', { name: '沙箱' })
    const loopbackSwitch = screen.getByRole('switch', { name: '允许本机回环' })
    expect(sandboxSwitch).toBeChecked()
    expect(loopbackSwitch).not.toBeChecked()
    fireEvent.click(loopbackSwitch)
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('turning allowUnsandboxedAuto on sends it in the saved config', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': { ok: true } })
    fireEvent.click(screen.getByRole('switch', { name: UNSANDBOXED_AUTO_LABEL }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    const sent = f.callsOf('permissions.set') as { config: PermissionsConfig }[]
    expect(sent[0].config.allowUnsandboxedAuto).toBe(true)
  })

  it('the network allow list is an editable tag input', async () => {
    await mount()
    const input = screen.getByLabelText('联网名单')
    fireEvent.change(input, { target: { value: 'another.test' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('another.test')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('typed-but-not-added tag text (no blur, no Enter) is still committed before save', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': { ok: true } })
    // 单独打字不算脏(没点添加、没失焦),所以先用别的编辑让保存可点——这才是会真正触发保存的场景
    fireEvent.click(screen.getByRole('switch', { name: '允许本机回环' }))
    fireEvent.change(screen.getByLabelText('联网名单'), { target: { value: 'pending.test' } })
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).not.toBeDisabled()
    await act(async () => { fireEvent.click(save) })
    const sent = f.callsOf('permissions.set') as { config: PermissionsConfig }[]
    expect(sent[0].config.network.allow).toContain('pending.test')
    expect(sent[0].config.sandbox.allowLoopback).toBe(true)
  })

  it('add, move and delete rule rows; match/noMatch tags edit inside a row', async () => {
    await mount({ 'permissions.get': getResult({ rules: [rule('shell(a)', { match: ['a'] }), rule('shell(b)', { effect: 'deny' })] }) })
    expect(rows()).toHaveLength(2)
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '下移' }))
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell(b)')
    const noMatch = within(rows()[1]).getByLabelText('不应匹配')
    fireEvent.change(noMatch, { target: { value: 'y' } })
    fireEvent.keyDown(noMatch, { key: 'Enter' })
    expect(within(rows()[1]).getByText('y')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }))
    expect(rows()).toHaveLength(3)
    fireEvent.click(within(rows()[2]).getByRole('button', { name: '删除' }))
    expect(rows()).toHaveLength(2)
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('save sends the whole draft (switches, rules, network) in one permissions.set call, disabled until dirty', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': { ok: true } })
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: '允许本机回环' }))
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(git log)' } })
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).not.toBeDisabled()
    await act(async () => { fireEvent.click(save) })
    const sent = f.callsOf('permissions.set') as { commandId: string; config: PermissionsConfig }[]
    expect(sent).toHaveLength(1)
    expect(sent[0].config).toEqual(baseConfig({
      sandbox: { enabled: true, allowLoopback: true },
      rules: [rule('shell(git log)', { match: ['git status'] })],
    }))
    expect(typeof sent[0].commandId).toBe('string')
    // 成功后重取:草稿变干净
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).toBeNull())
  })

  it('inputs are locked while the save is in flight', async () => {
    let resolveSet: ((v: { ok: boolean }) => void) | undefined
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => new Promise((resolve) => { resolveSet = resolve }) })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(git log)' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(within(rows()[0]).getByLabelText('规则')).toBeDisabled()
    expect(within(rows()[0]).getByLabelText('应匹配')).toBeDisabled()
    expect(screen.getByRole('switch', { name: '沙箱' })).toBeDisabled()
    expect(screen.getByLabelText('联网名单')).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加规则' })).toBeDisabled()
    await act(async () => { resolveSet!({ ok: true }) })
    await waitFor(() => expect(screen.queryByRole('button', { name: '保存' })).toBeNull())
  })

  it('two clicks in one frame save once (ref guard against double submit)', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => new Promise<never>(() => {}) })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'x' } })
    const save = screen.getByRole('button', { name: '保存' })
    act(() => { save.click(); save.click() })
    expect(f.callsOf('permissions.set')).toHaveLength(1)
  })

  it('invalid rules: errors land on the right row by id; the other row keeps its text; field-level errors show too', async () => {
    await mount({
      'permissions.get': getResult({ rules: [rule('shell(a)'), rule('shell(b)')] }),
      'permissions.set': () => fail(-32602, 'invalid rules', [
        { index: 1, rule: 'shell(b)', reason: 'pattern', case: 'x' },
        { index: -1, rule: 'network.allow', reason: 'syntax' },
      ]),
    })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(a2)' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(within(rows()[0]).queryByText('pattern')).toBeNull()
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell(a2)')
    expect(within(rows()[1]).getByText('pattern')).toBeInTheDocument()
    expect(within(rows()[1]).getByText('x')).toBeInTheDocument()
    expect(screen.getByText('syntax')).toBeInTheDocument()
  })

  it('after moving a rule, a failed save marks the moved rule by id, not whatever now sits at its old position', async () => {
    await mount({ 'permissions.get': getResult({ rules: [rule('shell(a)'), rule('shell(b)')] }) })
    fireEvent.click(within(rows()[1]).getByRole('button', { name: '上移' }))
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell(b)')
    f.script({ 'permissions.set': () => fail(-32602, 'invalid rules', [{ index: 0, rule: 'shell(b)', reason: 'pattern' }]) })
    fireEvent.change(within(rows()[1]).getByLabelText('规则'), { target: { value: 'shell(a2)' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(within(rows()[0]).getByText('pattern')).toBeInTheDocument()
    expect(within(rows()[1]).queryByText('pattern')).toBeNull()
  })

  it('a network-list error (reason:network) marks the network tag by index; it is not a rule-row error', async () => {
    await mount({
      'permissions.get': getResult({ network: { allow: ['good.com', 'bad entry'] } }),
      'permissions.set': () => fail(-32602, 'invalid rules', [{ index: 1, rule: 'bad entry', reason: 'network' }]),
    })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(x)' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(within(rows()[0]).queryByText('network')).toBeNull()
    const bad = screen.getByText('bad entry').closest('.mffai-tag') as HTMLElement
    const good = screen.getByText('good.com').closest('.mffai-tag') as HTMLElement
    expect(within(bad).getByText('network')).toBeInTheDocument()
    expect(within(good).queryByText('network')).toBeNull()
  })

  it('a generic save failure keeps the draft dirty; retry reuses the same commandId', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => fail(-32010, 'timeout') })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    const sent = f.callsOf('permissions.set') as { commandId: string }[]
    expect(sent[1].commandId).toBe(sent[0].commandId)
  })

  it('-32601 on permissions.get shows 不支持 with no editable draft', async () => {
    f = installFakeForge({ calls: { 'permissions.get': () => fail(-32601) } })
    renderPage()
    await screen.findByText('不支持')
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('-32601 on permissions.set shows 不支持', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => fail(-32601) })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    await screen.findByText('不支持')
  })

  it('the session selector re-runs permissions.get with the chosen sessionId', async () => {
    await mount({ 'session.list': { sessions: [summary('s1', { title: '一号' })] }, 'permissions.get': getResult() })
    const select = screen.getByLabelText<HTMLSelectElement>('会话')
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2))
    fireEvent.change(select, { target: { value: 's1' } })
    await waitFor(() => expect(f.callsOf('permissions.get').at(-1)).toEqual({ sessionId: 's1' }))
  })

  it('changing the session only refreshes defaults/sandbox; the global draft (and its dirty edit) is untouched', async () => {
    await mount({
      'session.list': { sessions: [summary('s1', { title: '一号' })] },
      'permissions.get': (p: { sessionId?: string }) =>
        p.sessionId === 's1' ? getResult({}, { level: 'full', missing: [], autoDegraded: false }) : getResult(),
    })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(dirty)' } })
    const select = screen.getByLabelText<HTMLSelectElement>('会话')
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2))
    fireEvent.change(select, { target: { value: 's1' } })
    await screen.findByText('完整')
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell(dirty)')
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    expect(screen.queryByRole('button', { name: '已在别处修改 · 重新载入' })).toBeNull()
  })

  it('a sequence guard on the session-scoped reload: switching A then B fast shows B, not a late A', async () => {
    const resolvers: Record<string, (v: ReturnType<typeof getResult>) => void> = {}
    f = installFakeForge({
      calls: {
        'session.list': { sessions: [summary('a', { title: 'A' }), summary('b', { title: 'B' })] },
        'permissions.get': (p: { sessionId?: string }) => {
          const sid = p.sessionId ?? ''
          return new Promise((resolve) => { resolvers[sid] = resolve })
        },
      },
    })
    renderPage()
    resolvers['']?.(getResult())
    await screen.findByRole('switch', { name: '沙箱' })
    const select = await screen.findByLabelText<HTMLSelectElement>('会话')
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3))
    fireEvent.change(select, { target: { value: 'a' } })
    fireEvent.change(select, { target: { value: 'b' } })
    await act(async () => { resolvers.b(getResult({}, { level: 'full', missing: [], autoDegraded: false })) })
    await screen.findByText('完整')
    await act(async () => { resolvers.a(getResult({}, { level: 'none', missing: ['proxy'], autoDegraded: true })) })
    expect(screen.queryByText('未隔离')).toBeNull()
    expect(screen.getByText('完整')).toBeInTheDocument()
  })

  it('a dirty draft ignores permissions.updated and shows the reload button instead of overwriting', async () => {
    await mount()
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'changed' } })
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
    act(() => { f.emit(ev('permissions.updated', { rules: 2, network: 1 })) })
    const reload = await screen.findByRole('button', { name: '已在别处修改 · 重新载入' })
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    // 后台已经变了:重新载入换成新草稿
    f.script({ 'permissions.get': getResult({ rules: [] }) })
    await act(async () => { fireEvent.click(reload) })
    expect(rows()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
  })

  it('a clean draft refetches silently on permissions.updated: no reload button', async () => {
    await mount()
    f.script({ 'permissions.get': getResult({ rules: [] }) })
    act(() => { f.emit(ev('permissions.updated', { rules: 0, network: 1 })) })
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(screen.queryByText('已在别处修改 · 重新载入')).toBeNull()
  })

  it('ignores its own permissions.updated while its save is still in flight: 已在别处修改 never flashes', async () => {
    let resolveSet: ((v: { ok: boolean }) => void) | undefined
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => new Promise((resolve) => { resolveSet = resolve }) })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell(x)' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    act(() => { f.emit(ev('permissions.updated', { rules: 1, network: 1 })) })
    expect(screen.queryByRole('button', { name: '已在别处修改 · 重新载入' })).toBeNull()
    await act(async () => { resolveSet!({ ok: true }) })
    expect(screen.queryByRole('button', { name: '已在别处修改 · 重新载入' })).toBeNull()
  })

  it('a dirty draft also ignores a reset (same dirty check as permissions.updated)', async () => {
    await mount()
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'changed' } })
    act(() => { f.alert({ kind: 'reset' }) })
    await screen.findByRole('button', { name: '已在别处修改 · 重新载入' })
  })

  it('a clean draft reloads fully on a reset', async () => {
    await mount()
    f.script({ 'permissions.get': getResult({ rules: [] }) })
    act(() => { f.alert({ kind: 'reset' }) })
    await waitFor(() => expect(rows()).toHaveLength(0))
  })
})
