import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PluginInstallStatus } from '@mffai/protocol'
import { Install, Staging } from './Install'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'
import { ev } from '../test/events'
import { FULL_CONSENT } from '../test/plugins'
import { findHints } from '../test/noHint'

afterEach(() => vi.useRealTimers())

const READY: PluginInstallStatus = { state: 'ready', consent: FULL_CONSENT, consentHash: 'hash-abc' }

async function ready(f: FakeForge, onInstalled = vi.fn(), onClose = vi.fn()) {
  f.script({ 'plugins.install.status': READY })
  render(<Staging stagingId="st1" onClose={onClose} onInstalled={onInstalled} />)
  await screen.findByRole('button', { name: '安装并启用' })
  return { onInstalled, onClose }
}

describe('Install form', () => {
  it('local path: prepare with {kind:path}, then the staging flow', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.prepare': { stagingId: 'st1' }, 'plugins.install.status': { state: 'fetching' } } })
    render(<Install onClose={() => {}} onInstalled={() => {}} />)
    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '/src/zed' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    expect(f.callsOf('plugins.install.prepare')).toEqual([{ source: { kind: 'path', path: '/src/zed' } }])
    await screen.findByText('读取中')
    expect(findHints()).toEqual([])
  })

  it('git: url, ref and 子目录; empty ones are left out', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.prepare': { stagingId: 'st1' }, 'plugins.install.status': { state: 'fetching' } } })
    render(<Install onClose={() => {}} onInstalled={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'git' }))
    fireEvent.change(screen.getByLabelText('地址'), { target: { value: 'https://example.com/z.git' } })
    fireEvent.change(screen.getByLabelText('ref'), { target: { value: 'v1' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    expect(f.callsOf('plugins.install.prepare')).toEqual([{ source: { kind: 'git', url: 'https://example.com/z.git', ref: 'v1' } }])
  })

  it('a refused prepare shows its code (bad_path); -32601 shows 不支持; double click sends once', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.prepare': () => fail(-32602, 'bad_path') } })
    render(<Install onClose={() => {}} onInstalled={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: 'git' }))
    fireEvent.change(screen.getByLabelText('地址'), { target: { value: 'https://example.com/z.git' } })
    fireEvent.change(screen.getByLabelText('子目录'), { target: { value: '../x' } })
    const btn = screen.getByRole('button', { name: '读取' })
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(f.callsOf('plugins.install.prepare')).toHaveLength(1)
    expect((await screen.findByText('bad_path')).tagName).toBe('CODE')
    f.script({ 'plugins.install.prepare': () => fail(-32601) })
    await act(async () => { fireEvent.click(btn) })
    await screen.findByText('不支持')
  })
})

describe('Staging', () => {
  it('fetching: spinner chip, polls install.status every second, and an install.state event refetches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const f = installFakeForge({ calls: { 'plugins.install.status': { state: 'fetching' } } })
    render(<Staging stagingId="st1" onClose={() => {}} onInstalled={() => {}} />)
    await screen.findByText('读取中')
    const n0 = f.callsOf('plugins.install.status').length
    await act(async () => { vi.advanceTimersByTime(1000) })
    await waitFor(() => expect(f.callsOf('plugins.install.status').length).toBe(n0 + 1))
    expect(f.callsOf('plugins.install.status')[0]).toEqual({ stagingId: 'st1' })
    f.script({ 'plugins.install.status': READY })
    await act(async () => { f.emit(ev('plugins.install.state', { stagingId: 'other', state: 'ready' })) })
    expect(f.callsOf('plugins.install.status').length).toBe(n0 + 1)
    await act(async () => { f.emit(ev('plugins.install.state', { stagingId: 'st1', state: 'ready' })) })
    await screen.findByRole('button', { name: '安装并启用' })
    // ready 之后不再轮询
    const n1 = f.callsOf('plugins.install.status').length
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(f.callsOf('plugins.install.status').length).toBe(n1)
  })

  it.each([
    ['consent_too_large', undefined],
    ['symlink', 'node_modules/.bin/evil'],
    ['bad_file_type', 'dev/fifo'],
  ])('failed: %s with its path', async (error, path) => {
    installFakeForge({ calls: { 'plugins.install.status': { state: 'failed', error, ...(path && { path }) } } })
    render(<Staging stagingId="st1" onClose={() => {}} onInstalled={() => {}} />)
    expect((await screen.findByText(error)).tagName).toBe('CODE')
    if (path) expect(screen.getByText(path).closest('.mffai-ptext')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull()
    expect(findHints()).toEqual([])
  })

  it('an upgrade starts from the current grants within the new declaration', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.status': READY, 'plugins.install.confirm': { ok: true, id: 'zed-tools' } } })
    const current = { servers: {
      'fs-server': { network: ['api.declared.example', 'gone.example'], cwd: 'none' as const },
      'net-server': { network: ['typed.example'], cwd: 'write' as const },
    } }
    render(<Staging stagingId="st1" current={current} onClose={() => {}} onInstalled={() => {}} />)
    const kept = await screen.findByLabelText('fs-server api.declared.example') as HTMLInputElement
    expect(kept.checked).toBe(true)
    const fs = document.querySelector('[data-grants="fs-server"]') as HTMLElement
    expect((fs.querySelector('input[type=radio]:checked') as HTMLInputElement).parentElement).toHaveTextContent('不给')
    expect(document.body.textContent).not.toContain('gone.example')
    expect(screen.getByText('typed.example')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '升级但停用' })) })
    expect((f.callsOf('plugins.install.confirm') as any[])[0].grants).toEqual({ servers: {
      'fs-server': { network: ['api.declared.example'], cwd: 'none' },
      'net-server': { network: ['typed.example'], cwd: 'write' },
    } })
  })

  it('取消 sends install.cancel and closes', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.cancel': { ok: true } } })
    const { onClose } = await ready(f)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    expect(f.callsOf('plugins.install.cancel')).toEqual([{ stagingId: 'st1' }])
    expect(onClose).toHaveBeenCalled()
  })

  it('leaving the page with an unconfirmed staging cancels it', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.status': { state: 'fetching' }, 'plugins.install.cancel': { ok: true } } })
    const { unmount } = render(<Staging stagingId="st1" onClose={() => {}} onInstalled={() => {}} />)
    await screen.findByText('读取中')
    unmount()
    expect(f.callsOf('plugins.install.cancel')).toEqual([{ stagingId: 'st1' }])
  })

  it('ready: the whole consent, the grants with no host checked, and no 同意 with 工具 on screen', async () => {
    const f = installFakeForge()
    await ready(f)
    expect(document.querySelector('[data-section="claimed"]')).not.toBeNull()
    expect(document.querySelector('[data-section="grants"]')).not.toBeNull()
    for (const h of ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']) expect(document.body).toHaveTextContent(h)
    expect([...document.querySelectorAll('input[type=checkbox]')].every((b) => !(b as HTMLInputElement).checked)).toBe(true)
    expect(document.body.textContent).not.toMatch(/同意[^]*工具|工具[^]*同意/)
    expect(screen.getAllByRole('button', { name: '安装并启用' })).toHaveLength(1)
    expect(findHints()).toEqual([])
  })

  it('安装并启用 sends consentHash, every server and enable:true once; success reports the id', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.confirm': { ok: true, id: 'zed-tools' }, 'plugins.install.cancel': { ok: true } } })
    const { onInstalled } = await ready(f)
    fireEvent.click(screen.getByLabelText('fs-server api.declared.example'))
    const btn = screen.getByRole('button', { name: '安装并启用' })
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    const sent = f.callsOf('plugins.install.confirm') as any[]
    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      commandId: expect.any(String), stagingId: 'st1', consentHash: 'hash-abc', enable: true,
      grants: { servers: { 'fs-server': { network: ['api.declared.example'], cwd: 'read' }, 'net-server': { network: [], cwd: 'read' } } },
    })
    expect(onInstalled).toHaveBeenCalledWith('zed-tools', true)
    // 确认过的暂存不再取消
    expect(f.callsOf('plugins.install.cancel')).toEqual([])
  })

  it('安装 sends enable:false; a refusal shows its code; a timeout retry reuses the commandId', async () => {
    let n = 0
    const f = installFakeForge({ calls: { 'plugins.install.confirm': () => (++n === 1 ? fail(-32010, 'timeout') : fail(-32602, 'consent_stale')) } })
    await ready(f)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装' })) })
    await screen.findByText('失败')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '安装' })) })
    expect((await screen.findByText('consent_stale')).tagName).toBe('CODE')
    const [a, b] = f.callsOf('plugins.install.confirm') as any[]
    expect(a.enable).toBe(false)
    expect(b.commandId).toBe(a.commandId)
  })
})

describe('Install 08b pane', () => {
  it('添加插件 heading, a close button, 本地路径 / git as a segmented tablist', () => {
    installFakeForge()
    const onClose = vi.fn()
    render(<Install onClose={onClose} onInstalled={() => {}} />)
    expect(screen.getByRole('heading', { name: '添加插件' })).toBeInTheDocument()
    const tabs = screen.getByRole('tablist')
    expect(tabs.classList.contains('mffai-seg')).toBe(true)
    expect(within(tabs).getByRole('tab', { name: '本地路径' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(findHints()).toEqual([])
  })

  it('after 读取 the form stays with 读取 disabled and the fetch shows under 获取记录 as a band', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.prepare': { stagingId: 'st1' }, 'plugins.install.status': { state: 'fetching' } } })
    render(<Install onClose={() => {}} onInstalled={() => {}} />)
    fireEvent.change(screen.getByLabelText('路径'), { target: { value: '/src/zed' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '读取' })) })
    await screen.findByText('读取中')
    expect(screen.getByText('获取记录')).toBeInTheDocument()
    expect(document.querySelector('.mffai-fetch.run')).toHaveTextContent('读取中')
    const go = screen.getByRole('button', { name: '读取' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.click(go)
    expect(f.callsOf('plugins.install.prepare')).toHaveLength(1)
  })

  it('a failed fetch is a bad band with its code and the path as PText', async () => {
    installFakeForge({ calls: { 'plugins.install.status': { state: 'failed', error: 'symlink', path: 'scripts/ssh-config' } } })
    render(<Staging stagingId="st1" onClose={() => {}} onInstalled={() => {}} />)
    await screen.findByText('symlink')
    const band = document.querySelector('.mffai-fetch.bad') as HTMLElement
    expect(within(band).getByText('symlink').tagName).toBe('CODE')
    expect(within(band).getByText('scripts/ssh-config').closest('.mffai-ptext')).not.toBeNull()
  })
})

describe('Staging 08b: first install is a full review page', () => {
  it('ready: the page (head with close, overview, two columns) and a footer with 联网 N 个地址, 项目目录 and 取消 · 安装 · 安装并启用', async () => {
    const f = installFakeForge()
    await ready(f)
    const page = document.querySelector('.mffai-cpage') as HTMLElement
    expect(page).not.toBeNull()
    expect(page.querySelector('[data-section="head"]')).not.toBeNull()
    expect(page.querySelectorAll('.mffai-covt')).toHaveLength(4)
    expect(page.querySelector('.mffai-ccol [data-section="grants"]')).not.toBeNull()
    const foot = page.querySelector('.mffai-cfoot') as HTMLElement
    expect([...foot.querySelectorAll('.mffai-chip')].map((c) => c.textContent)).toEqual(['联网 0 个地址', '项目目录 只读'])
    expect(within(foot).getAllByRole('button').map((b) => b.textContent)).toEqual(['取消', '安装', '安装并启用'])
    expect(document.querySelector('.mffai-covt:nth-child(2)')).toHaveTextContent('0 / 4 已勾')
    fireEvent.click(screen.getByLabelText('fs-server api.declared.example'))
    expect(foot.querySelector('.mffai-chip')).toHaveTextContent('联网 1 个地址')
    expect(document.querySelector('.mffai-covt:nth-child(2)')).toHaveTextContent('1 / 4 已勾')
    fireEvent.click(within(document.querySelector('[data-grants="net-server"]') as HTMLElement).getByLabelText('不给'))
    expect([...foot.querySelectorAll('.mffai-chip')][1]).toHaveTextContent('项目目录 只读 / 不给')
    expect(findHints()).toEqual([])
  })

  it('the head close button cancels the staging once, like 取消', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.cancel': { ok: true } } })
    const { onClose } = await ready(f)
    const head = document.querySelector('.mffai-cpage [data-section="head"]') as HTMLElement
    await act(async () => { fireEvent.click(within(head).getByRole('button', { name: '关闭' })) })
    expect(f.callsOf('plugins.install.cancel')).toEqual([{ stagingId: 'st1' }])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('安装并启用 from the page sends exactly the BASE params', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.confirm': { ok: true, id: 'zed-tools' } } })
    await ready(f)
    const foot = document.querySelector('.mffai-cfoot') as HTMLElement
    await act(async () => { fireEvent.click(within(foot).getByRole('button', { name: '安装并启用' })) })
    expect(f.callsOf('plugins.install.confirm')).toEqual([{
      commandId: expect.any(String), stagingId: 'st1', consentHash: 'hash-abc', enable: true,
      grants: { servers: { 'fs-server': { network: [], cwd: 'read' }, 'net-server': { network: [], cwd: 'read' } } },
    }])
  })

  it('an upgrade staging (with current) is not the page: no overview, the upgrade buttons', async () => {
    installFakeForge({ calls: { 'plugins.install.status': READY } })
    render(<Staging stagingId="st1" current={{ servers: {} }} onClose={() => {}} onInstalled={() => {}} />)
    await screen.findByRole('button', { name: '升级' })
    expect(document.querySelector('.mffai-cpage')).toBeNull()
    expect(document.querySelector('.mffai-covt')).toBeNull()
    expect(screen.queryByRole('button', { name: '安装并启用' })).toBeNull()
    expect(screen.getByRole('button', { name: '升级但停用' })).toBeInTheDocument()
  })
})

describe('Staging 08b: the page makes what it covers inert', () => {
  it('while the review page is up, everything around it inside .mffai-plugins is inert; after 取消 nothing is', async () => {
    const f = installFakeForge({ calls: { 'plugins.install.status': READY, 'plugins.install.cancel': { ok: true } } })
    function Host() {
      const [open, setOpen] = useState(true)
      return (
        <div className="mffai-plugins">
          <aside className="mffai-pcol"><button>row</button></aside>
          <div className="mffai-pright">{open && <Staging stagingId="st1" onClose={() => setOpen(false)} onInstalled={() => {}} />}</div>
        </div>
      )
    }
    render(<Host />)
    await screen.findByRole('button', { name: '安装并启用' })
    expect(document.querySelector('.mffai-pcol')!.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('.mffai-fetch.ok')!.hasAttribute('inert')).toBe(true)
    expect(document.querySelector('.mffai-cpage')!.closest('[inert]')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '取消' })) })
    expect(f.callsOf('plugins.install.cancel')).toEqual([{ stagingId: 'st1' }])
    expect(document.querySelector('[inert]')).toBeNull()
  })
})
