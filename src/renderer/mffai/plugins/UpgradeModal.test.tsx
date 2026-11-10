import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PluginDiff } from '@mffai/protocol'
import { UpgradeModal } from './UpgradeModal'
import { diffMarks } from './ConsentSection'
import { PluginDetail } from './PluginDetail'
import { installFakeForge } from '../test/fakeForge'
import { detailOf, FULL_CONSENT, listRow } from '../test/plugins'
import { findHints } from '../test/noHint'

const EMPTY: PluginDiff = {
  fromVersion: '1', toVersion: '2', sourceChanged: false,
  mcp: { added: [], removed: [], changed: [] }, skills: { added: [], removed: [], textChanged: [] }, commands: { added: [], removed: [], textChanged: [] },
  network: { added: [], removed: [] }, config: { added: [], requiredSensitive: [] }, notRun: { hooksAdded: [], hooksRemoved: [], added: [] },
  files: { from: 1, to: 1 }, integrity: null,
}
const HOOK = { event: 'E', command: 'c', masked: false }
const ALL_SAME = { mcp: { same: true }, network: { same: true }, notRun: { same: true }, skills: { same: true }, config: { same: true }, claimed: { same: true } }

describe('diffMarks', () => {
  it('an empty diff marks every section 未变', () => {
    expect(diffMarks(EMPTY)).toEqual(ALL_SAME)
  })

  it.each([
    ['mcp.added', { mcp: { ...EMPTY.mcp, added: ['a', 'b'] } }, 'mcp', { add: 2 }],
    ['mcp.changed', { mcp: { ...EMPTY.mcp, changed: [{ name: 'a', fields: ['args'] }] } }, 'mcp', { mod: 1 }],
    ['mcp.removed', { mcp: { ...EMPTY.mcp, removed: ['a'] } }, 'mcp', { del: 1 }],
    ['network.added', { network: { added: ['h'], removed: [] } }, 'network', { add: 1 }],
    ['network.removed', { network: { added: [], removed: ['h', 'i'] } }, 'network', { del: 2 }],
    ['notRun.hooksAdded', { notRun: { ...EMPTY.notRun, hooksAdded: [HOOK] } }, 'notRun', { add: 1 }],
    ['notRun.added', { notRun: { ...EMPTY.notRun, added: ['agents:x'] } }, 'notRun', { add: 1 }],
    ['notRun.hooksRemoved', { notRun: { ...EMPTY.notRun, hooksRemoved: [HOOK] } }, 'notRun', { del: 1 }],
    ['skills.added', { skills: { ...EMPTY.skills, added: ['s'] } }, 'skills', { add: 1 }],
    ['skills.textChanged', { skills: { ...EMPTY.skills, textChanged: ['s'] } }, 'skills', { mod: 1 }],
    ['skills.removed', { skills: { ...EMPTY.skills, removed: ['s'] } }, 'skills', { del: 1 }],
    ['commands.added', { commands: { ...EMPTY.commands, added: ['c'] } }, 'skills', { add: 1 }],
    ['commands.textChanged', { commands: { ...EMPTY.commands, textChanged: ['c'] } }, 'skills', { mod: 1 }],
    ['commands.removed', { commands: { ...EMPTY.commands, removed: ['c'] } }, 'skills', { del: 1 }],
    ['config.added', { config: { added: ['k'], requiredSensitive: [] } }, 'config', { add: 1 }],
    ['config.requiredSensitive', { config: { added: [], requiredSensitive: ['k'] } }, 'config', { add: 1 }],
  ] as const)('%s → only its section', (_n, patch, sec, want) => {
    expect(diffMarks({ ...EMPTY, ...patch } as unknown as PluginDiff)).toEqual({ ...ALL_SAME, [sec]: want })
  })

  it('versions, files, integrity and sourceChanged do not mark a section', () => {
    expect(diffMarks({ ...EMPTY, sourceChanged: true, files: { from: 1, to: 9 }, integrity: { from: 'a', to: 'b' } })).toEqual(ALL_SAME)
  })

  it('config: a new required sensitive key is counted once', () => {
    expect(diffMarks({ ...EMPTY, config: { added: ['k', 'j'], requiredSensitive: ['k'] } }).config).toEqual({ add: 2 })
  })
})

describe('UpgradeModal', () => {
  it('a dialog over a scrim; Esc closes without any call', () => {
    const f = installFakeForge()
    const onClose = vi.fn()
    render(<UpgradeModal onClose={onClose}><button>x</button></UpgradeModal>)
    const dlg = screen.getByRole('dialog')
    expect(dlg.getAttribute('aria-modal')).toBe('true')
    expect(dlg.closest('.mffai-umodal-scrim')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(f.calls).toEqual([])
    expect(findHints()).toEqual([])
  })

  it('a click on the scrim does not close it (an unconfirmed upgrade would be cancelled)', () => {
    installFakeForge()
    const onClose = vi.fn()
    render(<UpgradeModal onClose={onClose}><span>x</span></UpgradeModal>)
    fireEvent.click(document.querySelector('.mffai-umodal-scrim')!)
    expect(onClose).not.toHaveBeenCalled()
  })
})

const DETAIL = detailOf(FULL_CONSENT, {
  grants: { servers: { 'fs-server': { network: ['api.declared.example'], cwd: 'none' }, 'net-server': { network: [], cwd: 'read' } } },
  servers: [{ name: 'fs-server', state: 'stopped' }],
})
const ROW = listRow('zed-tools', { version: '1.2.0' })

async function openUpgrade(extra: Record<string, unknown> = {}) {
  let n = 0
  const f = installFakeForge({ calls: {
    'plugins.get': DETAIL, 'plugins.mcp.status': { servers: [] },
    'plugins.upgrade.prepare': () => ({ stagingId: `up${++n}` }),
    'plugins.install.status': (p: { stagingId: string }) => ({ state: 'ready', consent: FULL_CONSENT, consentHash: `hash-${p.stagingId}` }),
    'plugins.install.cancel': { ok: true },
    ...extra,
  } as never })
  const onEnabled = vi.fn()
  render(<PluginDetail plugin={ROW} showNewSession={false} onEnabled={onEnabled} onClose={() => {}} />)
  await waitFor(() => expect((screen.getByRole('button', { name: '升级' }) as HTMLButtonElement).disabled).toBe(false))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '升级' })) })
  const dlg = await screen.findByRole('dialog')
  await within(dlg).findByRole('button', { name: '升级' })
  return { f, dlg, onEnabled }
}

describe('PluginDetail upgrade modal', () => {
  it('the upgrade consent is a modal: head, every section, footer +N ~N −N, 取消 · 升级但停用 · 升级', async () => {
    const { dlg } = await openUpgrade()
    expect(dlg.querySelector('[data-staging="up1"]')).not.toBeNull()
    expect(within(dlg).getByText('来源已变')).toBeInTheDocument()
    for (const s of ['mcp', 'network', 'notrun', 'skillcmd', 'config', 'claimed', 'diff']) expect(dlg.querySelector(`[data-section="${s}"]`), s).not.toBeNull()
    expect([...dlg.querySelectorAll('.mffai-cfoot .mffai-ctotal .mffai-chip')].map((c) => c.textContent)).toEqual(['+ 8', '~ 3', '− 5'])
    expect(within(dlg).getAllByRole('button').map((b) => b.textContent).slice(-3)).toEqual(['取消', '升级但停用', '升级'])
    expect(within(dlg).queryByRole('button', { name: '安装并启用' })).toBeNull()
    expect([...dlg.querySelectorAll('input[type=checkbox]')].filter((b) => (b as HTMLInputElement).checked).map((b) => b.getAttribute('aria-label'))).toEqual(['fs-server api.declared.example'])
    expect(findHints()).toEqual([])
  })

  it('升级 sends the consentHash unchanged, every server from the current grants and enable:true', async () => {
    const { f, dlg, onEnabled } = await openUpgrade({ 'plugins.install.confirm': { ok: true, id: 'zed-tools' } })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '升级' })) })
    expect(f.callsOf('plugins.install.confirm')).toEqual([{
      commandId: expect.any(String), stagingId: 'up1', consentHash: 'hash-up1', enable: true,
      grants: { servers: { 'fs-server': { network: ['api.declared.example'], cwd: 'none' }, 'net-server': { network: [], cwd: 'read' } } },
    }])
    expect(onEnabled).toHaveBeenCalledWith('zed-tools', true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.callsOf('plugins.install.cancel')).toEqual([])
  })

  it('升级但停用 sends enable:false', async () => {
    const { f, dlg } = await openUpgrade({ 'plugins.install.confirm': { ok: true, id: 'zed-tools' } })
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '升级但停用' })) })
    expect((f.callsOf('plugins.install.confirm') as { enable: boolean }[]).map((c) => c.enable)).toEqual([false])
  })

  it('Esc closes the modal and, unconfirmed, cancels the staging once', async () => {
    const { f } = await openUpgrade()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.callsOf('plugins.install.cancel')).toEqual([{ stagingId: 'up1' }])
    expect(screen.getByRole('button', { name: '升级' })).toBeInTheDocument()
  })

  it('取消 cancels once and closes', async () => {
    const { f, dlg } = await openUpgrade()
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '取消' })) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(f.callsOf('plugins.install.cancel')).toEqual([{ stagingId: 'up1' }])
  })

  it('the head 升级 and ref are disabled while a staging is open: a second press sends no prepare, a confirm never pairs a new staging with the old hash', async () => {
    const { f, dlg } = await openUpgrade({ 'plugins.install.confirm': { ok: true, id: 'zed-tools' } })
    const head = document.querySelector('.mffai-dhead') as HTMLElement
    const again = within(head).getByRole('button', { name: '升级' }) as HTMLButtonElement
    expect(again.disabled).toBe(true)
    expect((within(head).getByLabelText('升级 ref') as HTMLInputElement).disabled).toBe(true)
    await act(async () => { fireEvent.click(again) })
    expect(f.callsOf('plugins.upgrade.prepare')).toHaveLength(1)
    await act(async () => { fireEvent.click(within(dlg).getByRole('button', { name: '升级' })) })
    const sent = f.callsOf('plugins.install.confirm') as { stagingId: string; consentHash: string }[]
    expect(sent.map((c) => [c.stagingId, c.consentHash])).toEqual([['up1', 'hash-up1']])
  })

  it('a new staging after closing starts from a fresh Staging (keyed): its own hash, not the old one', async () => {
    const { f } = await openUpgrade({ 'plugins.install.confirm': { ok: true, id: 'zed-tools' } })
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '升级' })) })
    const dlg = await screen.findByRole('dialog')
    await waitFor(() => expect(dlg.querySelector('[data-staging="up2"]')).not.toBeNull())
    await act(async () => { fireEvent.click(await within(dlg).findByRole('button', { name: '升级' })) })
    const sent = f.callsOf('plugins.install.confirm') as { stagingId: string; consentHash: string }[]
    expect(sent.map((c) => [c.stagingId, c.consentHash])).toEqual([['up2', 'hash-up2']])
  })
})
