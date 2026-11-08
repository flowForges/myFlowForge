import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import PluginsPage from './PluginsPage'
import { fail, installFakeForge } from '../test/fakeForge'
import { ev } from '../test/events'
import { detailOf, FULL_CONSENT, listRow, pluginList } from '../test/plugins'
import { findHints } from '../test/noHint'
import { route } from '../route'

const row = (id: string) => document.querySelector(`[data-plugin="${id}"]`) as HTMLElement
const STATUS = { state: 'running', uptimeMs: 1, rssMb: 1, version: '0.1.0', plugins: [] }
const LIST = pluginList({
  plugins: [
    listRow('zed-tools', { version: '1.2.0', source: { kind: 'git', url: 'https://example.com/z.git', commit: 'c0ffee12', ref: 'v1' } }),
    listRow('broken', { enabled: false, state: 'integrity_failed', problems: ['integrity_failed'] }),
  ],
  dev: [{ id: 'dev-a', hash: 'hash-dev', trustedAt: 1 }],
})

beforeEach(() => route.set({ page: 'plugins' }))

describe('PluginsPage', () => {
  it('rows: id, version, format, source (path or url@commit), state + problems, enable switch, 详情; dev group', async () => {
    installFakeForge({ calls: { 'plugins.list': LIST, status: STATUS as never, 'plugins.mcp.status': { servers: [] } } })
    render(<PluginsPage />)
    await screen.findByText('zed-tools')
    const z = row('zed-tools')
    expect(z).toHaveTextContent('1.2.0')
    expect(z).toHaveTextContent('native')
    expect(z).toHaveTextContent('https://example.com/z.git@c0ffee12')
    expect((within(z).getByRole('switch', { name: '启用 zed-tools' }) as HTMLInputElement).checked).toBe(true)
    expect(within(z).getByRole('button', { name: '详情' })).toBeInTheDocument()
    const b = row('broken')
    expect(b).toHaveTextContent('/src/broken')
    expect(within(b).getByText('integrity_failed').tagName).toBe('CODE')
    expect((within(b).getByRole('switch') as HTMLInputElement).checked).toBe(false)
    expect(document.querySelector('[data-dev="dev-a"]')).not.toBeNull()
    expect(findHints()).toEqual([])
  })

  it('enable and disable call setEnabled; 新会话 appears after enabling and opens a new session', async () => {
    const f = installFakeForge({ calls: { 'plugins.list': LIST, status: STATUS as never, 'plugins.mcp.status': { servers: [] }, 'plugins.setEnabled': { ok: true } } })
    render(<PluginsPage />)
    await screen.findByText('broken')
    expect(within(row('broken')).queryByRole('button', { name: '新会话' })).toBeNull()
    const sw = within(row('broken')).getByRole('switch')
    await act(async () => { fireEvent.click(sw) })
    expect(f.callsOf('plugins.setEnabled')).toEqual([{ commandId: expect.any(String), id: 'broken', enabled: true }])
    f.script({ 'plugins.list': { ...LIST, plugins: LIST.plugins.map((p) => ({ ...p, enabled: true })) } })
    await act(async () => { f.emit(ev('plugins.enabled', { id: 'broken' })) })
    const ns = await within(row('broken')).findByRole('button', { name: '新会话' })
    fireEvent.click(ns)
    expect(route.get()).toEqual({ page: 'chat', newSession: {} })

    await act(async () => { fireEvent.click(within(row('zed-tools')).getByRole('switch')) })
    expect((f.callsOf('plugins.setEnabled') as any[])[1]).toMatchObject({ id: 'zed-tools', enabled: false })
  })

  it('a refused enable shows its code on the row', async () => {
    installFakeForge({ calls: { 'plugins.list': LIST, status: STATUS as never, 'plugins.mcp.status': { servers: [] }, 'plugins.setEnabled': () => fail(-32602, 'integrity_failed') } })
    render(<PluginsPage />)
    await screen.findByText('broken')
    await act(async () => { fireEvent.click(within(row('broken')).getByRole('switch')) })
    await waitFor(() => expect(within(row('broken')).getAllByText('integrity_failed')).toHaveLength(2))
  })

  it('store_recovered: 存储已恢复 chip and 丢弃遗留 behind a confirm → plugins.store.discard; other problems as codes', async () => {
    const f = installFakeForge({ calls: {
      'plugins.list': pluginList({ problems: ['store_recovered', 'store_odd'] }), status: STATUS as never, 'plugins.mcp.status': { servers: [] },
      'plugins.store.discard': { ok: true },
    } })
    render(<PluginsPage />)
    expect(await screen.findByText('存储已恢复')).toBeInTheDocument()
    expect(screen.getByText('store_odd').tagName).toBe('CODE')
    fireEvent.click(screen.getByRole('button', { name: '丢弃遗留' }))
    const dlg = screen.getByRole('dialog')
    expect(findHints()).toEqual([])
    const go = within(dlg).getByRole('button', { name: '丢弃遗留' })
    await act(async () => { fireEvent.click(go); fireEvent.click(go) })
    expect(f.callsOf('plugins.store.discard')).toEqual([{ commandId: expect.any(String) }])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a refused discard stays in the dialog with its code', async () => {
    installFakeForge({ calls: {
      'plugins.list': pluginList({ problems: ['store_recovered'] }), status: STATUS as never, 'plugins.mcp.status': { servers: [] },
      'plugins.store.discard': () => fail(-32602, 'secrets_unavailable'),
    } })
    render(<PluginsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '丢弃遗留' }))
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '丢弃遗留' })) })
    expect(within(screen.getByRole('dialog')).getByText('secrets_unavailable')).toBeInTheDocument()
  })

  it('添加 opens the install form; 安装并启用 there shows 新会话 on the new row', async () => {
    const f = installFakeForge({ calls: {
      'plugins.list': LIST, status: STATUS as never, 'plugins.mcp.status': { servers: [] },
      'plugins.install.prepare': { stagingId: 'st1' },
      'plugins.install.status': { state: 'ready', consent: FULL_CONSENT, consentHash: 'h' },
      'plugins.install.confirm': { ok: true, id: 'zed-tools' },
    } })
    render(<PluginsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '添加' }))
    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '/src/zed' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    const go = await screen.findByRole('button', { name: '安装并启用' })
    await act(async () => { fireEvent.click(go) })
    expect(f.callsOf('plugins.install.confirm')).toHaveLength(1)
    await within(row('zed-tools')).findByRole('button', { name: '新会话' })
    expect(document.querySelector('[data-staging]')).toBeNull()
  })

  it('详情 opens the detail; dev_crashed from status shows 已跳过', async () => {
    installFakeForge({ calls: {
      'plugins.list': LIST, status: { ...STATUS, problems: ['dev_crashed'] } as never, 'plugins.mcp.status': { servers: [] },
      'plugins.get': detailOf(FULL_CONSENT),
    } })
    render(<PluginsPage />)
    await screen.findByText('已跳过')
    fireEvent.click(within(row('zed-tools')).getByRole('button', { name: '详情' }))
    await waitFor(() => expect(document.querySelector('[data-detail="zed-tools"]')).not.toBeNull())
    await screen.findByRole('button', { name: '保存授权' })
    expect(findHints()).toEqual([])
  })

  it('list events reload; -32601 → 不支持', async () => {
    const f = installFakeForge({ calls: { 'plugins.list': pluginList(), status: STATUS as never, 'plugins.mcp.status': { servers: [] } } })
    const { unmount } = render(<PluginsPage />)
    await waitFor(() => expect(f.callsOf('plugins.list')).toHaveLength(1))
    f.script({ 'plugins.list': LIST })
    await act(async () => { f.emit(ev('plugins.installed', { id: 'zed-tools', version: '1.2.0', integrity: 'x', format: 'native', sourceKind: 'git' })) })
    await screen.findByText('zed-tools')
    unmount()
    installFakeForge({ calls: { 'plugins.list': () => fail(-32601), status: STATUS as never, 'plugins.mcp.status': { servers: [] } } })
    render(<PluginsPage />)
    await screen.findByText('不支持')
  })
})
