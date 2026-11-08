import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import type { Grants as GrantsT, PluginConsent } from '@mffai/protocol'
import { Grants, initialGrants, upgradeGrants } from './Grants'
import { FULL_CONSENT } from '../test/plugins'
import { findHints } from '../test/noHint'

const BAD_NAME: PluginConsent['mcp'][number] = { ...FULL_CONSENT.mcp[1], name: 'bad name!', problems: ['name_invalid'] }
const NONE_CWD: PluginConsent['mcp'][number] = { ...FULL_CONSENT.mcp[0], name: 'no-cwd', declared: { network: [], cwd: 'none' }, suggestedHosts: [] }
const MCP = [...FULL_CONSENT.mcp, BAD_NAME, NONE_CWD]

function Harness({ onChange }: { onChange: (g: GrantsT) => void }) {
  const [g, setG] = useState(() => initialGrants(MCP))
  return <Grants mcp={MCP} value={g} onChange={(n) => { setG(n); onChange(n) }} />
}
const box = (server: string) => document.querySelector(`[data-grants="${server}"]`) as HTMLElement

describe('initialGrants', () => {
  it('every server with a valid name: no network, cwd 只读 capped by the declaration', () => {
    expect(initialGrants(MCP)).toEqual({ servers: {
      'fs-server': { network: [], cwd: 'read' },
      'net-server': { network: [], cwd: 'read' },
      'no-cwd': { network: [], cwd: 'none' },
    } })
  })

  it('starts from current grants where given, defaults for the rest, drops unknown servers', () => {
    const cur = { servers: { 'fs-server': { network: ['api.declared.example'], cwd: 'none' as const }, gone: { network: [], cwd: 'write' as const } } }
    expect(initialGrants(MCP, cur)).toEqual({ servers: {
      'fs-server': { network: ['api.declared.example'], cwd: 'none' },
      'net-server': { network: [], cwd: 'read' },
      'no-cwd': { network: [], cwd: 'none' },
    } })
  })
})

describe('upgradeGrants', () => {
  it('keeps current grants within the new declaration: cwd capped, undeclared hosts dropped, hand-typed hosts kept without a declaration', () => {
    const cur = { servers: {
      'fs-server': { network: ['api.declared.example', 'gone.example'], cwd: 'none' as const },
      'net-server': { network: ['typed.example'], cwd: 'write' as const },
    } }
    expect(upgradeGrants(FULL_CONSENT.mcp, cur)).toEqual({ servers: {
      'fs-server': { network: ['api.declared.example'], cwd: 'none' },
      'net-server': { network: ['typed.example'], cwd: 'write' },
    } })
    const wide = { servers: { 'fs-server': { network: [], cwd: 'write' as const } } }
    expect(upgradeGrants(FULL_CONSENT.mcp, wide).servers['fs-server'].cwd).toBe('read')
    // 新服务从默认开始
    expect(upgradeGrants(FULL_CONSENT.mcp, { servers: {} }).servers['net-server']).toEqual({ network: [], cwd: 'read' })
  })

  it('a wildcard declaration covers its subdomains', () => {
    const mcp = [{ ...FULL_CONSENT.mcp[0], declared: { network: ['*.example.org'], cwd: 'read' as const } }]
    const cur = { servers: { 'fs-server': { network: ['a.example.org', 'example.com'], cwd: 'read' as const } } }
    expect(upgradeGrants(mcp, cur).servers['fs-server'].network).toEqual(['a.example.org'])
    const g = upgradeGrants(mcp, cur)
    render(<Grants mcp={mcp} value={g} onChange={() => {}} />)
    expect((screen.getByLabelText('fs-server a.example.org') as HTMLInputElement).checked).toBe(true)
  })
})

describe('Grants', () => {
  it('其他域名 only for servers without a declaration (native plugins can only narrow)', () => {
    render(<Harness onChange={() => {}} />)
    expect(within(box('fs-server')).queryByLabelText('其他域名 fs-server')).toBeNull()
    expect(within(box('net-server')).getByLabelText('其他域名 net-server')).toBeInTheDocument()
  })

  it('name_invalid servers and prototype names are never granted, and nothing touches Object.prototype', () => {
    const mcp = [
      { ...FULL_CONSENT.mcp[1], name: 'okname', problems: ['name_invalid'] },
      { ...FULL_CONSENT.mcp[1], name: '__proto__', problems: [] },
      { ...FULL_CONSENT.mcp[1], name: 'constructor', problems: [] },
      FULL_CONSENT.mcp[1],
    ]
    const g = initialGrants(mcp, { servers: JSON.parse('{"__proto__": {"network": ["x.example"], "cwd": "write"}}') })
    expect(Object.keys(g.servers)).toEqual(['net-server'])
    expect(({} as Record<string, unknown>).network).toBeUndefined()
    expect(Object.getPrototypeOf(g.servers)).toBeNull()
    render(<Grants mcp={mcp} value={g} onChange={() => {}} />)
    expect(box('okname')).toBeNull()
    expect(box('__proto__')).toBeNull()
  })

  it('suggested and declared hosts are checkboxes, none checked by default', () => {
    render(<Harness onChange={() => {}} />)
    const boxes = [...document.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
    expect(boxes.map((b) => b.getAttribute('aria-label')).sort()).toEqual([
      'fs-server api.declared.example', 'fs-server registry.npmjs.org', 'net-server files.pythonhosted.org', 'net-server pypi.org',
    ])
    expect(boxes.every((b) => !b.checked)).toBe(true)
    expect(box('bad name!')).toBeNull()
    expect(findHints()).toEqual([])
  })

  it('checking a host, adding another, choosing cwd: every server is always emitted', () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('net-server pypi.org'))
    let g = onChange.mock.lastCall![0] as GrantsT
    expect(Object.keys(g.servers).sort()).toEqual(['fs-server', 'net-server', 'no-cwd'])
    expect(g.servers['net-server'].network).toEqual(['pypi.org'])

    const other = screen.getByLabelText('其他域名 net-server')
    fireEvent.change(other, { target: { value: 'api.example.org' } })
    fireEvent.keyDown(other, { key: 'Enter' })
    g = onChange.mock.lastCall![0]
    expect(g.servers['net-server'].network).toEqual(['pypi.org', 'api.example.org'])
    expect(within(box('net-server')).getByText('api.example.org')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('net-server pypi.org'))
    g = onChange.mock.lastCall![0]
    expect(g.servers['net-server'].network).toEqual(['api.example.org'])

    fireEvent.click(within(box('net-server')).getByLabelText('读写'))
    g = onChange.mock.lastCall![0]
    expect(g.servers['net-server'].cwd).toBe('write')
    expect(g.servers['fs-server']).toEqual({ network: [], cwd: 'read' })
  })

  it('cwd above the declaration is disabled', () => {
    render(<Harness onChange={() => {}} />)
    const fs = box('fs-server')
    expect((within(fs).getByLabelText('读写') as HTMLInputElement).disabled).toBe(true)
    expect((within(fs).getByLabelText('只读') as HTMLInputElement).checked).toBe(true)
    const none = box('no-cwd')
    expect((within(none).getByLabelText('只读') as HTMLInputElement).disabled).toBe(true)
    expect((within(none).getByLabelText('不给') as HTMLInputElement).checked).toBe(true)
    expect((within(box('net-server')).getByLabelText('读写') as HTMLInputElement).disabled).toBe(false)
  })

  it('server names are third-party text', () => {
    render(<Harness onChange={() => {}} />)
    expect(within(box('fs-server')).getByText('fs-server').closest('.mffai-ptext')).not.toBeNull()
  })
})
