import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { PluginDetail } from './PluginDetail'
import { fail, installFakeForge } from '../test/fakeForge'
import { ev } from '../test/events'
import { detailOf, FULL_CONSENT, listRow } from '../test/plugins'
import { findHints } from '../test/noHint'

const DETAIL = detailOf(FULL_CONSENT, {
  grants: { servers: { 'fs-server': { network: ['api.declared.example'], cwd: 'none' }, 'net-server': { network: [], cwd: 'read' } } },
  settings: [{ key: 'API_TOKEN', set: true, sensitive: true }],
  servers: [{ name: 'fs-server', state: 'refused', reason: 'cwd_too_broad' }, { name: 'net-server', state: 'stopped' }],
})
const ROW = listRow('zed-tools', { version: '1.2.0' })

function mount(o: { enabled?: boolean; onEnabled?: (id: string, on: boolean) => void; onClose?: () => void; newSession?: boolean } = {}) {
  return render(<PluginDetail plugin={{ ...ROW, enabled: o.enabled ?? true }} showNewSession={o.newSession ?? false}
    onEnabled={o.onEnabled ?? (() => {})} onClose={o.onClose ?? (() => {})} />)
}

describe('PluginDetail', () => {
  it('loads plugins.get: grants from the record, settings, server states', async () => {
    const f = installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] } } })
    mount()
    await screen.findByText('未启动')
    expect(f.callsOf('plugins.get')).toEqual([{ id: 'zed-tools' }])
    expect((screen.getByLabelText('fs-server api.declared.example') as HTMLInputElement).checked).toBe(true)
    const fs = document.querySelector('[data-grants="fs-server"]') as HTMLElement
    expect((within(fs).getByLabelText('不给') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('cwd_too_broad')).toBeInTheDocument()
    expect(screen.getByText('已停止')).toBeInTheDocument()
    expect(within(document.querySelector('[data-setting="API_TOKEN"]') as HTMLElement).getByText('已设置')).toBeInTheDocument()
    expect(findHints()).toEqual([])
  })

  it('保存授权 sends grants.set with a commandId and every server', async () => {
    const f = installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] }, 'plugins.grants.set': { ok: true } } })
    mount()
    const pypi = await screen.findByLabelText('net-server pypi.org')
    fireEvent.click(pypi)
    const btn = screen.getByRole('button', { name: '保存授权' })
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(f.callsOf('plugins.grants.set')).toEqual([{
      commandId: expect.any(String), id: 'zed-tools',
      grants: { servers: { 'fs-server': { network: ['api.declared.example'], cwd: 'none' }, 'net-server': { network: ['pypi.org'], cwd: 'read' } } },
    }])
  })

  it('a grants refusal shows its code', async () => {
    installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] }, 'plugins.grants.set': () => fail(-32602, 'grants_exceed_declared') } })
    mount()
    const save = await screen.findByRole('button', { name: '保存授权' })
    await act(async () => { fireEvent.click(save) })
    expect((await screen.findByText('grants_exceed_declared')).tagName).toBe('CODE')
  })

  it('禁用 / 启用 call setEnabled; 新会话 opens a new session through the route', async () => {
    const f = installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] }, 'plugins.setEnabled': { ok: true } } })
    const onEnabled = vi.fn()
    const { unmount } = mount({ onEnabled })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '禁用' })) })
    expect(f.callsOf('plugins.setEnabled')).toEqual([{ commandId: expect.any(String), id: 'zed-tools', enabled: false }])
    expect(onEnabled).toHaveBeenCalledWith('zed-tools', false)
    unmount()
    mount({ enabled: false, onEnabled })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '启用' })) })
    expect((f.callsOf('plugins.setEnabled') as any[])[1]).toMatchObject({ id: 'zed-tools', enabled: true })
    expect(onEnabled).toHaveBeenLastCalledWith('zed-tools', true)
  })

  it('enable refused with integrity_failed shows the code', async () => {
    installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] }, 'plugins.setEnabled': () => fail(-32602, 'integrity_failed') } })
    mount({ enabled: false })
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '启用' })) })
    expect(await screen.findByText('integrity_failed')).toBeInTheDocument()
  })

  it('卸载: confirm with the 保留 row, then uninstall and close', async () => {
    const f = installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] }, 'plugins.uninstall': { ok: true } } })
    const onClose = vi.fn()
    mount({ onClose })
    fireEvent.click(await screen.findByRole('button', { name: '卸载' }))
    const dlg = screen.getByRole('dialog')
    const rows = [...dlg.querySelectorAll('.mffai-confirm-row')].map((r) => r.textContent)
    expect(rows).toContain('保留事件日志里已发生的调用记录')
    expect(rows).toEqual(expect.arrayContaining(['删除插件代码', '删除plugin-data', '删除插件的凭据']))
    expect(rows.some((r) => r?.includes('zed-tools'))).toBe(true)
    expect(findHints()).toEqual([])
    const btn = within(dlg).getByRole('button', { name: '卸载' })
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(f.callsOf('plugins.uninstall')).toEqual([{ commandId: expect.any(String), id: 'zed-tools' }])
    expect(onClose).toHaveBeenCalled()
  })

  it('升级 with a ref: upgrade.prepare then the consent with its diff', async () => {
    const f = installFakeForge({ calls: {
      'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] },
      'plugins.upgrade.prepare': { stagingId: 'up1' },
      'plugins.install.status': { state: 'ready', consent: FULL_CONSENT, consentHash: 'h2' },
    } })
    mount()
    await screen.findByText('未启动')
    fireEvent.change(screen.getByLabelText('升级 ref'), { target: { value: 'v2' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '升级' })) })
    expect(f.callsOf('plugins.upgrade.prepare')).toEqual([{ id: 'zed-tools', ref: 'v2' }])
    await screen.findByText('来源已变')
    const fs = document.querySelector('[data-grants="fs-server"]') as HTMLElement
    expect((within(fs).getByLabelText('不给') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('fs-server api.declared.example') as HTMLInputElement).checked).toBe(true)
    expect(document.querySelector('[data-section="diff"]')).toHaveTextContent('sha256-OLDINTEGRITY → sha256-INTEGRITY0123')
    expect(findHints()).toEqual([])
  })

  it('升级 without a ref leaves it out', async () => {
    const f = installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] }, 'plugins.upgrade.prepare': () => fail(-32602, 'bad_ref') } })
    mount()
    await screen.findByText('未启动')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '升级' })) })
    expect(f.callsOf('plugins.upgrade.prepare')).toEqual([{ id: 'zed-tools' }])
    expect(await screen.findByText('bad_ref')).toBeInTheDocument()
  })

  it('新会话 shows when asked and sets the route', async () => {
    installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] } } })
    const { route } = await import('../route')
    mount({ newSession: true })
    fireEvent.click(await screen.findByRole('button', { name: '新会话' }))
    expect(route.get()).toEqual({ page: 'chat', newSession: {} })
  })

  it('升级 waits for the detail: the current grants are its starting point', async () => {
    installFakeForge({ calls: { 'plugins.get': () => new Promise(() => {}), 'plugins.mcp.status': { servers: [] } } })
    mount()
    expect((screen.getByRole('button', { name: '升级' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a grants.updated event for it reloads; uninstalled closes; -32601 → 不支持', async () => {
    const f = installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] } } })
    const onClose = vi.fn()
    const { unmount } = mount({ onClose })
    await screen.findByText('未启动')
    await act(async () => { f.emit(ev('plugins.grants.updated', { id: 'other' })) })
    expect(f.callsOf('plugins.get')).toHaveLength(1)
    await act(async () => { f.emit(ev('plugins.grants.updated', { id: 'zed-tools' })) })
    await waitFor(() => expect(f.callsOf('plugins.get')).toHaveLength(2))
    await act(async () => { f.emit(ev('plugins.uninstalled', { id: 'zed-tools' })) })
    expect(onClose).toHaveBeenCalled()
    unmount()
    installFakeForge({ calls: { 'plugins.get': () => fail(-32601), 'plugins.mcp.status': { servers: [] } } })
    mount()
    await screen.findByText('不支持')
  })
})

describe('PluginDetail 08b', () => {
  it('the tab bar jumps to sections: scrollIntoView on the section, every section stays mounted', async () => {
    installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] } } })
    const spy = vi.fn()
    const orig = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = spy
    try {
      mount()
      await screen.findByText('未启动')
      const nav = screen.getByRole('navigation', { name: '分区' })
      expect([...nav.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['授权', '配置', '服务 2', '内容'])
      for (const [name, sec] of [[/^授权/, 'grants'], [/^配置/, 'settings'], [/^服务/, 'servers'], [/^内容/, 'content']] as const) {
        fireEvent.click(within(nav).getByRole('button', { name }))
        expect(spy.mock.contexts.at(-1)).toBe(document.querySelector(`[data-dsec="${sec}"]`))
        for (const s of ['grants', 'settings', 'servers', 'content']) expect(document.querySelector(`[data-dsec="${s}"]`), s).not.toBeNull()
        for (const s of ['grants', 'settings', 'servers']) expect(document.querySelector(`[data-section="${s}"]`), s).not.toBeNull()
      }
      expect(spy).toHaveBeenCalledTimes(4)
    } finally { Element.prototype.scrollIntoView = orig }
  })

  it('head: id, version and source as PText, the format code, the state; 内容 lists integrity, skills and commands as PText', async () => {
    installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] } } })
    mount()
    await screen.findByText('未启动')
    const head = document.querySelector('.mffai-dhead') as HTMLElement
    for (const t of ['zed-tools', '1.2.0', '/src/zed-tools']) expect(within(head).getByText(t).closest('.mffai-ptext'), t).not.toBeNull()
    expect(within(head).getByText('native').tagName).toBe('CODE')
    expect(within(head).getByText('已启用')).toBeInTheDocument()
    for (const b of ['升级', '禁用', '卸载']) expect(within(head).getByRole('button', { name: b })).toBeInTheDocument()
    const content = document.querySelector('[data-dsec="content"]') as HTMLElement
    for (const t of ['sha256-INTEGRITY0123', 'skill-alpha', 'cmd-beta']) {
      const el = within(content).getByText(t)
      expect(el.closest('.mffai-ptext'), t).not.toBeNull()
      expect(el.closest('button, a, .mffai-chip'), t).toBeNull()
    }
    expect(content).toHaveTextContent('37')
  })

  it('the 服务 card shows the per-session table without the 插件 column', async () => {
    installFakeForge({ calls: { 'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [{ plugin: 'zed-tools', server: 'fs-server', sessionId: 's1', state: 'running', pid: 7 }] } } })
    mount()
    await screen.findByText('未启动')
    const card = document.querySelector('[data-dsec="servers"]') as HTMLElement
    await waitFor(() => expect(card.querySelector('[data-mcp-row="zed-tools/s1/fs-server"]')).not.toBeNull())
    expect([...card.querySelectorAll('.mffai-mcp th')].map((t) => t.textContent)).toEqual(['服务', '会话', '状态', 'pid'])
  })
})
