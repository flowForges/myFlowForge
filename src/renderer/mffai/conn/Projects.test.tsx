// Telegram 项目表(08 §10.3、Review Focus 7):别名、PathField、AutoSwitch(同一个标签),沙箱不是 full 时禁用,
// 旁边是级别块。保存走 config.set,带整份配置:不认识的键和没改的项目原样回去。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useRef } from 'react'
import type { SandboxStatus } from '@mffai/protocol'
import { Projects as ProjectsView, useConfigSaver, type FullConfig } from './Projects'
import { AUTO_LABEL } from '../ui/AutoSwitch'
import { installFakeForge, fail, type FakeForge } from '../test/fakeForge'

let f: FakeForge

/** 和 Telegram 页一样:一个共享的保存器,保存后重取(这里是 onSaved) */
function Projects({ config, level, onSaved }: { config: FullConfig; level?: SandboxStatus['level']; onSaved: () => void }) {
  const ref = useRef(config)
  ref.current = config
  const saver = useConfigSaver(() => ref.current, async () => { onSaved() })
  return <ProjectsView config={config} level={level} saver={saver} />
}
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

  it.each([['partial', '部分'], ['none', '未隔离']] as const)('level %s: an off switch is disabled with the level chip beside it', (level, chip) => {
    f = installFakeForge()
    render(<Projects config={config()} level={level} onSaved={() => {}} />)
    expect(within(rows()[0]).getByRole('switch')).toBeDisabled()
    for (const r of rows()) expect(within(r).getByText(chip)).toBeInTheDocument()
  })

  it('level partial with a project at auto:true: the switch can still be turned off, and the save goes through', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': ({ config: c }) => {
      if ((c as { projects: { auto: boolean }[] }).projects.some((p) => p.auto)) fail(-32602, 'auto_requires_full')
      return { ok: true }
    } } })
    render(<Projects config={config()} level="partial" onSaved={() => {}} />)
    const sw = within(rows()[1]).getByRole('switch')
    expect(sw).not.toBeDisabled()
    fireEvent.click(sw)
    expect(sw).not.toBeChecked()
    // 关掉之后它也禁用了:不能再打开
    expect(sw).toBeDisabled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(sent()).toHaveLength(1)
    expect(screen.queryByText('auto_requires_full')).toBeNull()
    expect(screen.queryByText('失败')).toBeNull()
  })

  it('a row with an empty alias or path is not sent, and is marked', async () => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': { ok: true } } })
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
    fireEvent.change(within(rows()[2]).getByLabelText('别名'), { target: { value: 'n' } })
    fireEvent.change(within(rows()[0]).getByLabelText('路径'), { target: { value: '  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(sent()).toHaveLength(0)
    expect(rows().map((r) => r.hasAttribute('data-invalid'))).toEqual([true, false, true])
    expect(within(rows()[0]).getByLabelText('路径')).toHaveAttribute('aria-invalid', 'true')
    expect(within(rows()[2]).getByLabelText('路径')).toHaveAttribute('aria-invalid', 'true')
    expect(within(rows()[2]).getByLabelText('别名')).not.toHaveAttribute('aria-invalid', 'true')
    // 改了那一行,标记就去掉
    fireEvent.change(within(rows()[0]).getByLabelText('路径'), { target: { value: '/w/api' } })
    expect(rows()[0].hasAttribute('data-invalid')).toBe(false)
  })

  it.each([
    ['an index', { index: 1 }],
    ['a name', { name: 'web' }],
  ])('invalid_project naming the row by %s marks that row with the code', async (_n, data) => {
    f = installFakeForge({ calls: { 'channel.telegram.config.set': () => fail(-32602, 'invalid_project', data) } })
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    fireEvent.change(within(rows()[1]).getByLabelText('路径'), { target: { value: '/' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(rows().map((r) => r.hasAttribute('data-invalid'))).toEqual([false, true])
    expect(within(rows()[1]).getByText('invalid_project')).toBeInTheDocument()
    expect(screen.getAllByText('invalid_project')).toHaveLength(1)
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

  it('08b: a head with the count and an add button; each row has a folder button and a delete icon; the switch is a warn row', () => {
    f = installFakeForge()
    render(<Projects config={config()} level="full" onSaved={() => {}} />)
    expect(document.querySelector('.mffai-tg-projects .mffai-sech')!.textContent).toContain('项目')
    expect(document.querySelector('.mffai-tg-projects .mffai-sech .mffai-count')!.textContent).toBe('2')
    expect(screen.getByRole('button', { name: '添加项目' }).textContent).toBe('添加')
    for (const r of rows()) {
      expect(r.querySelector('.mffai-pathfield button svg')).not.toBeNull()
      expect(within(r).getByRole('button', { name: '删除' }).querySelector('svg')).not.toBeNull()
      expect(r.querySelector('label.mffai-switch.mffai-warnrow')).not.toBeNull()
    }
    expect(rows()[0].querySelector('.mffai-warnrow')!.textContent).toBe(AUTO_LABEL)
  })
})
