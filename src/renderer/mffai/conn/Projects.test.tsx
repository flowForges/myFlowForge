// Telegram 项目表(08 §10.3、Review Focus 7):别名、PathField、AutoSwitch(同一个标签),沙箱不是 full 时禁用,
// 旁边是级别块。保存走 config.set,带整份配置:不认识的键和没改的项目原样回去。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Projects } from './Projects'
import { AUTO_LABEL } from '../ui/AutoSwitch'
import { installFakeForge, fail, type FakeForge } from '../test/fakeForge'

let f: FakeForge
const config = () => ({
  enabled: true, staleMinutes: 10, future: { x: 1 },
  projects: [
    { name: 'api', path: '/w/api', auto: false, extra: 'keep' },
    { name: 'web', path: '/w/web', auto: true },
  ],
})
const rows = () => [...document.querySelectorAll('[data-project-row]')] as HTMLElement[]
const sent = () => f.callsOf('channel.telegram.config.set') as { commandId: string; config: unknown }[]

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('Projects', () => {
  it('one row per project: alias, path field, the auto switch with the exact label', () => {
    f = installFakeForge()
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    expect(rows()).toHaveLength(2)
    const r0 = within(rows()[0])
    expect(r0.getByLabelText<HTMLInputElement>('别名').value).toBe('api')
    expect(r0.getByLabelText<HTMLInputElement>('路径').value).toBe('/w/api')
    expect(rows()[0].querySelector('label.mffai-switch')!.textContent).toBe(AUTO_LABEL)
    expect(r0.getByRole('switch')).not.toBeChecked()
    expect(within(rows()[1]).getByRole('switch')).toBeChecked()
    expect(r0.getByRole('switch')).not.toBeDisabled()
    expect(r0.queryByText('部分')).toBeNull()
  })

  it.each([['partial', '部分'], ['none', '未隔离']] as const)('level %s: the switch is disabled with the level chip beside it', (level, chip) => {
    f = installFakeForge()
    render(<Projects config={config()} level={level} onSaved={() => {}} />)
    for (const r of rows()) {
      expect(within(r).getByRole('switch')).toBeDisabled()
      expect(within(r).getByText(chip)).toBeInTheDocument()
    }
  })

  it('level unknown (permissions.get failed): disabled', () => {
    f = installFakeForge()
    render(<Projects config={config()} onSaved={() => {}} />)
    expect(within(rows()[0]).getByRole('switch')).toBeDisabled()
  })

  it('save sends the whole config: unknown keys and the untouched project intact', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': { ok: true } } })
    const onSaved = vi.fn()
    render(<Projects config={config()} level="full" onSaved={onSaved} />)
    const save = screen.getByRole('button', { name: '保存' })
    expect(save).toBeDisabled()
    fireEvent.change(within(rows()[0]).getByLabelText('别名'), { target: { value: 'backend' } })
    fireEvent.click(within(rows()[0]).getByRole('switch'))
    await act(async () => { fireEvent.click(save) })
    expect(sent()).toHaveLength(1)
    expect(sent()[0].config).toEqual({
      enabled: true, staleMinutes: 10, future: { x: 1 },
      projects: [
        { name: 'backend', path: '/w/api', auto: true, extra: 'keep' },
        { name: 'web', path: '/w/web', auto: true },
      ],
    })
    expect(typeof sent()[0].commandId).toBe('string')
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it('add and delete rows; a new row starts with auto off', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': { ok: true } } })
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    fireEvent.click(within(rows()[0]).getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
    expect(rows()).toHaveLength(2)
    const last = within(rows()[1])
    expect(last.getByRole('switch')).not.toBeChecked()
    fireEvent.change(last.getByLabelText('别名'), { target: { value: 'new' } })
    fireEvent.change(last.getByLabelText('路径'), { target: { value: '/w/new' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect((sent()[0].config as { projects: unknown }).projects).toEqual([
      { name: 'web', path: '/w/web', auto: true },
      { name: 'new', path: '/w/new', auto: false },
    ])
  })

  it('a refusal shows its code; a retry of the same draft reuses the commandId', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': () => fail(-32602, 'invalid_project') } })
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    fireEvent.change(within(rows()[0]).getByLabelText('路径'), { target: { value: '/' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(screen.getByText('invalid_project')).toBeInTheDocument()
    f.script({ 'channel.telegram.config.set': () => fail(-32010, 'timeout') })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(screen.getByText('失败')).toBeInTheDocument()
    expect(sent()[1].commandId).toBe(sent()[0].commandId)
  })

  it('-32601 → 不支持', async () => {
    f = installFakeForge()
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    fireEvent.change(within(rows()[0]).getByLabelText('别名'), { target: { value: 'x' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(screen.getByText('不支持')).toBeInTheDocument()
  })

  it('a new config from the parent replaces a clean draft', () => {
    f = installFakeForge()
    const { rerender } = render(<Projects config={config()} level="full" onSaved={() => {}} />)
    rerender(<Projects config={{ ...config(), projects: [{ name: 'only', path: '/o', auto: false }] }} level="full" onSaved={() => {}} />)
    expect(rows()).toHaveLength(1)
    expect(within(rows()[0]).getByLabelText<HTMLInputElement>('别名').value).toBe('only')
  })

  it('two clicks in one frame save once', () => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': () => new Promise<never>(() => {}) } })
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    fireEvent.change(within(rows()[0]).getByLabelText('别名'), { target: { value: 'x' } })
    const save = screen.getByRole('button', { name: '保存' })
    act(() => { save.click(); save.click() })
    expect(sent()).toHaveLength(1)
  })
})
