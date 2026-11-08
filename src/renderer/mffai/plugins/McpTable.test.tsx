import { describe, it, expect } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { McpStateCell, McpTable } from './McpTable'
import { fail, installFakeForge } from '../test/fakeForge'
import { ev } from '../test/events'
import { findHints } from '../test/noHint'

const row = (server: string) => document.querySelector(`[data-mcp-row$="/${server}"]`) as HTMLElement
const servers = [
  { plugin: 'zed', server: 'a', sessionId: 's1', state: 'refused', reason: 'cwd_too_broad' },
  { plugin: 'zed', server: 'b', sessionId: 's1', state: 'stopped', reason: 'init_timeout' },
  { plugin: 'zed', server: 'c', sessionId: 's2', state: 'stopped' },
  { plugin: 'zed', server: 'd', sessionId: 's2', state: 'running', pid: 4242 },
  { plugin: 'other', server: 'e', sessionId: 's2', state: 'weird_state', reason: 'odd_reason' },
] as const

describe('McpStateCell', () => {
  it('refused → 未启动 + code; stopped with code → 已退出 + code; plain stopped → 已停止; unknown verbatim', () => {
    const { container } = render(
      <>
        <div data-x="1"><McpStateCell state="refused" reason="cwd_too_broad" /></div>
        <div data-x="2"><McpStateCell state="stopped" reason="init_timeout" /></div>
        <div data-x="3"><McpStateCell state="stopped" /></div>
        <div data-x="4"><McpStateCell state="needs_config" reason="needs_config" /></div>
        <div data-x="5"><McpStateCell state="weird_state" /></div>
      </>,
    )
    const t = (n: number) => container.querySelector(`[data-x="${n}"]`)!.textContent
    expect(t(1)).toBe('未启动cwd_too_broad')
    expect(t(2)).toBe('已退出init_timeout')
    expect(t(3)).toBe('已停止')
    expect(t(4)).toBe('需要配置needs_config')
    expect(t(5)).toBe('weird_state')
  })
})

describe('McpTable', () => {
  it('lists every server row: plugin, server, session, state, reason, pid (no sessionId filter)', async () => {
    const f = installFakeForge({ calls: { 'plugins.mcp.status': { servers: servers as never } } })
    render(<McpTable />)
    await screen.findByText('未启动')
    expect(f.callsOf('plugins.mcp.status')).toEqual([{}])
    expect(row('a')).toHaveTextContent('未启动')
    expect(within(row('a')).getByText('cwd_too_broad').tagName).toBe('CODE')
    expect(row('b')).toHaveTextContent('已退出')
    expect(within(row('b')).getByText('init_timeout')).toBeInTheDocument()
    expect(row('c')).toHaveTextContent('已停止')
    expect(row('d')).toHaveTextContent('运行中')
    expect(row('d')).toHaveTextContent('4242')
    expect(row('d')).toHaveTextContent('s2')
    expect(row('e')).toHaveTextContent('weird_state')
    expect(row('e')).toHaveTextContent('odd_reason')
    expect(findHints()).toEqual([])
  })

  it('filters by plugin', async () => {
    installFakeForge({ calls: { 'plugins.mcp.status': { servers: servers as never } } })
    render(<McpTable plugin="other" />)
    await screen.findByText('weird_state')
    expect(row('a')).toBeNull()
  })

  it('a plugins.mcp.status event refreshes the table', async () => {
    const f = installFakeForge({ calls: { 'plugins.mcp.status': { servers: [] } } })
    render(<McpTable />)
    await waitFor(() => expect(f.callsOf('plugins.mcp.status')).toHaveLength(1))
    f.script({ 'plugins.mcp.status': { servers: [{ plugin: 'zed', server: 'a', sessionId: 's1', state: 'starting' }] } })
    await act(async () => { f.emit(ev('plugins.mcp.status', { plugin: 'zed', server: 'a', state: 'starting' }, { sessionId: 's1' })) })
    await screen.findByText('启动中')
  })

  it('-32601 → 不支持; other failures → 失败', async () => {
    installFakeForge({ calls: { 'plugins.mcp.status': () => fail(-32601) } })
    const { unmount } = render(<McpTable />)
    await screen.findByText('不支持')
    unmount()
    installFakeForge({ calls: { 'plugins.mcp.status': () => fail(-32603, 'x') } })
    render(<McpTable />)
    await screen.findByText('失败')
  })
})
