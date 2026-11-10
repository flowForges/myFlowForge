import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DevMode, basename } from './DevMode'
import { fail, installFakeForge } from '../test/fakeForge'
import { findHints } from '../test/noHint'

const TRUST = { ok: true, id: 'dev-zed', hash: 'hash-0123abcd', bytes: 2048, main: 'dist/plugin.mjs', restartRequired: true as const }
const group = () => document.querySelector('[data-section="dev"]') as HTMLElement

describe('basename', () => {
  it.each([['/a/b/dev-zed', 'dev-zed'], ['/a/b/dev-zed/', 'dev-zed'], ['C:\\x\\dev-zed', 'dev-zed'], ['dev-zed', 'dev-zed']])('%s', (p, b) => {
    expect(basename(p)).toBe(b)
  })
})

describe('DevMode', () => {
  it('the group always carries 完全访问; each dev plugin shows its hash and trust time', () => {
    installFakeForge()
    render(<DevMode dev={[{ id: 'dev-a', hash: 'hash-aaaa', trustedAt: 1_700_000_000_000 }]} problems={[]} onChanged={() => {}} />)
    expect(within(group()).getByText('完全访问').className).toContain('bad')
    const row = document.querySelector('[data-dev="dev-a"]') as HTMLElement
    expect(row).toHaveTextContent('hash-aaaa')
    expect(row.querySelector('time')).not.toBeNull()
    expect(within(group()).queryByText('已跳过')).toBeNull()
    expect(findHints()).toEqual([])
  })

  it('dev_crashed → 已跳过 in the group head', () => {
    installFakeForge()
    render(<DevMode dev={[]} problems={['dev_crashed']} onChanged={() => {}} />)
    expect(within(group()).getByText('已跳过')).toBeInTheDocument()
  })

  it('信任: the confirm needs the exact folder name, sends acknowledge, then shows id/hash/bytes/main and 重启后台', async () => {
    const f = installFakeForge({ calls: { 'plugins.dev.trust': TRUST } })
    render(<DevMode dev={[]} problems={[]} onChanged={() => {}} />)
    const trust = screen.getByRole('button', { name: '信任' }) as HTMLButtonElement
    expect(trust.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('开发插件目录'), { target: { value: '/work/dev-zed' } })
    fireEvent.click(trust)
    const dlg = screen.getByRole('dialog')
    expect(dlg).toHaveAccessibleName('以完全访问权限运行')
    expect(dlg).toHaveTextContent('/work/dev-zed')
    const nameRow = [...dlg.querySelectorAll('.mffai-confirm-row')].find((r) => r.querySelector('.mffai-k')?.textContent === '目录名')!
    expect(nameRow.querySelector('.mffai-ptext')!.textContent).toBe('dev-zed')
    expect(within(dlg).getByRole('textbox').getAttribute('aria-label')).not.toContain('dev-zed')
    expect(findHints()).toEqual([])
    const go = within(dlg).getByRole('button', { name: '以完全访问权限运行' }) as HTMLButtonElement
    const typed = within(dlg).getByRole('textbox')
    for (const near of ['dev-ze', 'dev-zed ', 'Dev-zed', '/work/dev-zed']) {
      fireEvent.change(typed, { target: { value: near } })
      expect(go.disabled, near).toBe(true)
    }
    fireEvent.change(typed, { target: { value: 'dev-zed' } })
    expect(go.disabled).toBe(false)
    await act(async () => { fireEvent.click(go); fireEvent.click(go) })
    expect(f.callsOf('plugins.dev.trust')).toEqual([{ path: '/work/dev-zed', acknowledge: 'runs_with_full_access' }])
    const res = document.querySelector('[data-dev-result]') as HTMLElement
    for (const s of ['dev-zed', 'hash-0123abcd', '2048', 'dist/plugin.mjs']) expect(res, s).toHaveTextContent(s)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重启后台' })) })
    expect(f.mffai.restart).toHaveBeenCalledTimes(1)
  })

  it('the typed name and the folder name are compared after NFC', async () => {
    const f = installFakeForge({ calls: { 'plugins.dev.trust': TRUST } })
    const nfd = 'cafe\u0301'
    const nfc = 'caf\u00e9'
    render(<DevMode dev={[]} problems={[]} onChanged={() => {}} />)
    fireEvent.change(screen.getByLabelText('开发插件目录'), { target: { value: `/w/${nfd}` } })
    fireEvent.click(screen.getByRole('button', { name: '信任' }))
    const dlg = screen.getByRole('dialog')
    fireEvent.change(within(dlg).getByRole('textbox'), { target: { value: nfc } })
    const go = within(dlg).getByRole('button', { name: '以完全访问权限运行' }) as HTMLButtonElement
    expect(go.disabled).toBe(false)
    await act(async () => { fireEvent.click(go) })
    expect(f.callsOf('plugins.dev.trust')).toEqual([{ path: `/w/${nfd}`, acknowledge: 'runs_with_full_access' }])
  })

  it('a refused trust shows its code in the dialog', async () => {
    installFakeForge({ calls: { 'plugins.dev.trust': () => fail(-32602, 'id_not_dev') } })
    render(<DevMode dev={[]} problems={[]} onChanged={() => {}} />)
    fireEvent.change(screen.getByLabelText('开发插件目录'), { target: { value: '/work/zed' } })
    fireEvent.click(screen.getByRole('button', { name: '信任' }))
    fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox'), { target: { value: 'zed' } })
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '以完全访问权限运行' })) })
    expect(within(screen.getByRole('dialog')).getByText('id_not_dev')).toBeInTheDocument()
  })

  it('移除 sends dev.remove then offers 重启后台', async () => {
    const f = installFakeForge({ calls: { 'plugins.dev.remove': { ok: true, restartRequired: true } } })
    render(<DevMode dev={[{ id: 'dev-a', hash: 'h', trustedAt: 1 }]} problems={[]} onChanged={() => {}} />)
    const btn = screen.getByRole('button', { name: '移除' })
    await act(async () => { fireEvent.click(btn); fireEvent.click(btn) })
    expect(f.callsOf('plugins.dev.remove')).toEqual([{ id: 'dev-a' }])
    await waitFor(() => expect(screen.getByRole('button', { name: '重启后台' })).toBeInTheDocument())
  })
})

describe('DevMode 08b', () => {
  it('+ in the group head focuses the folder field; the trust confirm is unchanged behind it', () => {
    installFakeForge()
    render(<DevMode dev={[{ id: 'dev-a', hash: 'hash-aaaa', trustedAt: 1 }]} problems={[]} onChanged={() => {}} />)
    const head = group().querySelector('.mffai-grouphead') as HTMLElement
    expect(within(head).getByText('完全访问')).toBeInTheDocument()
    fireEvent.click(within(head).getByRole('button', { name: '添加开发插件' }))
    expect(document.activeElement).toBe(screen.getByLabelText('开发插件目录'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(within(document.querySelector('[data-dev="dev-a"]') as HTMLElement).getByText('dev-a').closest('.mffai-ptext')).not.toBeNull()
  })
})
