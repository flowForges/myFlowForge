import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Settings } from './Settings'
import { fail, installFakeForge } from '../test/fakeForge'
import { FULL_CONSENT } from '../test/plugins'
import { findHints } from '../test/noHint'

const SECRET = 'sk-PLUGIN-SECRET-9f8e7d'
const row = (key: string) => document.querySelector(`[data-setting="${key}"]`) as HTMLElement
const settings = [
  { key: 'API_TOKEN', set: false, sensitive: true },
  { key: 'region', set: true, sensitive: false, value: 'eu-west' },
  { key: 'MCP_VAR', set: true, sensitive: true },
]

afterEach(() => vi.restoreAllMocks())

describe('Settings', () => {
  it('rows: key, title, chips; sensitive shows only 已设置 / 未设置 in a password box; plain shows its value', () => {
    installFakeForge()
    render(<Settings id="zed-tools" config={FULL_CONSENT.config} settings={settings} onChanged={() => {}} />)
    const tok = row('API_TOKEN')
    expect(tok).toHaveTextContent('Api token title')
    expect(within(tok).getByText('未设置')).toBeInTheDocument()
    expect(within(tok).getByText('必填')).toBeInTheDocument()
    expect((within(tok).getByLabelText('API_TOKEN') as HTMLInputElement).type).toBe('password')
    expect(within(tok).queryByRole('button', { name: '清除' })).toBeNull()
    const mcpVar = row('MCP_VAR')
    expect(within(mcpVar).getByText('已设置')).toBeInTheDocument()
    expect(within(mcpVar).getByRole('button', { name: '清除' })).toBeInTheDocument()
    const region = row('region')
    expect(region).toHaveTextContent('eu-west')
    expect((within(region).getByLabelText('region') as HTMLInputElement).type).toBe('text')
    expect(findHints()).toEqual([])
  })

  it('saving a sensitive value: settings.set without commandId, input cleared, the value is nowhere after', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const f = installFakeForge({ calls: { 'plugins.settings.set': { ok: true } } })
    const onChanged = vi.fn()
    render(<Settings id="zed-tools" config={FULL_CONSENT.config} settings={settings} onChanged={onChanged} />)
    const input = within(row('API_TOKEN')).getByLabelText('API_TOKEN') as HTMLInputElement
    fireEvent.change(input, { target: { value: SECRET } })
    const save = within(row('API_TOKEN')).getByRole('button', { name: '保存' })
    await act(async () => { fireEvent.click(save); fireEvent.click(save) })
    expect(f.callsOf('plugins.settings.set')).toEqual([{ id: 'zed-tools', key: 'API_TOKEN', value: SECRET }])
    expect(input.value).toBe('')
    expect(onChanged).toHaveBeenCalled()
    expect(document.body.innerHTML).not.toContain(SECRET)
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET)
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET)
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET)
  })

  it('a failed save keeps the value out of logs and shows the code', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    installFakeForge({ calls: { 'plugins.settings.set': () => fail(-32602, 'secrets_unavailable') } })
    render(<Settings id="zed-tools" config={FULL_CONSENT.config} settings={settings} onChanged={() => {}} />)
    fireEvent.change(within(row('API_TOKEN')).getByLabelText('API_TOKEN'), { target: { value: SECRET } })
    await act(async () => { fireEvent.click(within(row('API_TOKEN')).getByRole('button', { name: '保存' })) })
    expect((await screen.findByText('secrets_unavailable')).tagName).toBe('CODE')
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET)
    expect(document.body.innerHTML).not.toContain(SECRET)
  })

  it('清除 sends settings.clear; a plain value saves too; -32601 shows 不支持', async () => {
    const f = installFakeForge({ calls: { 'plugins.settings.clear': { ok: true }, 'plugins.settings.set': () => fail(-32601) } })
    render(<Settings id="zed-tools" config={FULL_CONSENT.config} settings={settings} onChanged={() => {}} />)
    await act(async () => { fireEvent.click(within(row('MCP_VAR')).getByRole('button', { name: '清除' })) })
    expect(f.callsOf('plugins.settings.clear')).toEqual([{ id: 'zed-tools', key: 'MCP_VAR' }])
    fireEvent.change(within(row('region')).getByLabelText('region'), { target: { value: 'us' } })
    await act(async () => { fireEvent.click(within(row('region')).getByRole('button', { name: '保存' })) })
    expect(f.callsOf('plugins.settings.set')).toEqual([{ id: 'zed-tools', key: 'region', value: 'us' }])
    expect(within(row('region')).getByText('不支持')).toBeInTheDocument()
  })
})
