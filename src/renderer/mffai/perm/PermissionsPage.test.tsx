// 权限页(08 §11、Review Focus 7):本地草稿(规则、联网名单、三个开关),规则增删移和 match/noMatch 标签,
// 默认规则只读,沙箱级别和 missing 代码块,会话选择器重取 permissions.get,保存发整份配置且 ref 守卫双发,
// invalid rules 按 index 标红对应行其余不动,脏草稿收到 permissions.updated 换成「已在别处修改 · 重新载入」,
// -32601 → 不支持。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PermissionsConfig, SandboxStatus } from '@mffai/protocol'
import PermissionsPage from './PermissionsPage'
import { UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { fail, installFakeForge, type CallTable, type FakeForge } from '../test/fakeForge'
import { ev, resetSeq } from '../test/events'
import { summary } from '../test/sessions'

let f: FakeForge

const baseConfig = (patch: Partial<PermissionsConfig> = {}): PermissionsConfig => ({
  rules: [{ effect: 'ask', rule: 'shell:*', match: ['ls'], noMatch: [] }],
  network: { allow: ['example.com'] },
  sandbox: { enabled: true, allowLoopback: false },
  allowUnsandboxedAuto: false,
  ...patch,
})
const getResult = (
  configPatch: Partial<PermissionsConfig> = {},
  sandbox: SandboxStatus = { level: 'partial', missing: ['proxy'], autoDegraded: false },
) => ({ config: baseConfig(configPatch), defaults: ['shell:read'], errors: [], sandbox })

const rows = () => [...document.querySelectorAll('[data-rule]')] as HTMLElement[]

async function mount(calls: CallTable = { 'permissions.get': getResult() }) {
  f = installFakeForge({ calls })
  render(<PermissionsPage />)
  await screen.findByRole('button', { name: '保存' })
}

beforeEach(() => {
  resetSeq()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('PermissionsPage', () => {
  it('loads the draft: rule row, network tag, switches and sandbox chips', async () => {
    await mount()
    expect(rows()).toHaveLength(1)
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('shell:*')
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText('shell:read')).toBeInTheDocument()
    expect(screen.getByText('proxy')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
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

  it('the network allow list is an editable tag input', async () => {
    await mount()
    const input = screen.getByLabelText('联网名单')
    fireEvent.change(input, { target: { value: 'another.test' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('another.test')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存' })).not.toBeDisabled()
  })

  it('add, move and delete rule rows; match/noMatch tags edit inside a row', async () => {
    await mount({ 'permissions.get': getResult({ rules: [
      { effect: 'ask', rule: 'a', match: ['x'], noMatch: [] },
      { effect: 'deny', rule: 'b', match: [], noMatch: [] },
    ] }) })
    expect(rows()).toHaveLength(2)
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '下移' }))
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('b')
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
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole('switch', { name: '允许本机回环' }))
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'shell:read' } })
    expect(save).not.toBeDisabled()
    await act(async () => { fireEvent.click(save) })
    const sent = f.callsOf('permissions.set') as { commandId: string; config: PermissionsConfig }[]
    expect(sent).toHaveLength(1)
    expect(sent[0].config).toEqual(baseConfig({
      sandbox: { enabled: true, allowLoopback: true },
      rules: [{ effect: 'ask', rule: 'shell:read', match: ['ls'], noMatch: [] }],
    }))
    expect(typeof sent[0].commandId).toBe('string')
    // 成功后重取:草稿变干净
    await waitFor(() => expect(save).toBeDisabled())
  })

  it('two clicks in one frame save once (ref guard against double submit)', async () => {
    await mount({ 'permissions.get': getResult(), 'permissions.set': () => new Promise<never>(() => {}) })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'x' } })
    const save = screen.getByRole('button', { name: '保存' })
    act(() => { save.click(); save.click() })
    expect(f.callsOf('permissions.set')).toHaveLength(1)
  })

  it('invalid rules: errors land on the right row by index; the other row keeps its text; field-level errors show too', async () => {
    await mount({
      'permissions.get': getResult({ rules: [
        { effect: 'ask', rule: 'a', match: [], noMatch: [] },
        { effect: 'ask', rule: 'b', match: [], noMatch: [] },
      ] }),
      'permissions.set': () => fail(-32602, 'invalid rules', [
        { index: 1, rule: 'b', reason: 'pattern', case: 'x' },
        { index: -1, rule: 'network.allow', reason: 'network' },
      ]),
    })
    fireEvent.change(within(rows()[0]).getByLabelText('规则'), { target: { value: 'a2' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(within(rows()[0]).queryByText('pattern')).toBeNull()
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('规则').value).toBe('a2')
    expect(within(rows()[1]).getByText('pattern')).toBeInTheDocument()
    expect(within(rows()[1]).getByText('x')).toBeInTheDocument()
    expect(screen.getByText('network')).toBeInTheDocument()
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
    render(<PermissionsPage />)
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
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
  })

  it('a clean draft refetches silently on permissions.updated: no reload button', async () => {
    await mount()
    f.script({ 'permissions.get': getResult({ rules: [] }) })
    act(() => { f.emit(ev('permissions.updated', { rules: 0, network: 1 })) })
    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(screen.queryByText('已在别处修改 · 重新载入')).toBeNull()
  })
})
