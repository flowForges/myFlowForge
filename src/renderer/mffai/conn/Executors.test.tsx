import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ExecutorListResult } from '@mffai/protocol'
import { Executors } from './Executors'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'

let f: FakeForge

describe('Executors', () => {
  it('lists each executor: install/version, auth, isolation, missing codes', async () => {
    f = installFakeForge({ calls: {
      'executor.list': { executors: [
        { id: 'claude', installed: true, version: '1.2.3', auth: 'ok', isolation: 'own', missing: [] },
        { id: 'codex', installed: false, auth: 'missing', isolation: 'none', missing: ['codex_selftest', 'codex_network'] },
      ] },
    } })
    render(<Executors />)
    const claude = (await screen.findByText('claude')).closest('[data-executor]') as HTMLElement
    expect(within(claude).getByText('已安装 1.2.3')).toBeInTheDocument()
    expect(within(claude).getByText('已登录')).toBeInTheDocument()
    expect(within(claude).getByText('自带隔离')).toBeInTheDocument()
    const codex = (await screen.findByText('codex')).closest('[data-executor]') as HTMLElement
    expect(within(codex).getByText('未安装')).toBeInTheDocument()
    expect(within(codex).getByText('未登录')).toBeInTheDocument()
    expect(within(codex).getByText('未隔离')).toBeInTheDocument()
    expect(within(codex).getByText('codex_selftest')).toBeInTheDocument()
    expect(within(codex).getByText('codex_network')).toBeInTheDocument()
  })

  it('unknown auth code shows 未知', async () => {
    f = installFakeForge({ calls: {
      'executor.list': { executors: [{ id: 'x', installed: true, auth: 'unknown', isolation: 'wrapped', missing: [] }] },
    } })
    render(<Executors />)
    expect(await screen.findByText('未知')).toBeInTheDocument()
    expect(screen.getByText('沙箱包裹')).toBeInTheDocument()
  })

  it('a failed initial load shows 失败', async () => {
    f = installFakeForge({ calls: { 'executor.list': () => fail(-32603, 'boom') } })
    render(<Executors />)
    expect(await screen.findByText('失败')).toBeInTheDocument()
  })

  it('刷新 calls executor.refresh, shows a spinner chip while pending, and replaces the rows', async () => {
    let resolve!: (v: ExecutorListResult) => void
    f = installFakeForge({ calls: {
      'executor.list': { executors: [{ id: 'claude', installed: true, version: '1.0.0', auth: 'ok', isolation: 'own', missing: [] }] },
    } })
    f.script({ 'executor.refresh': () => new Promise<ExecutorListResult>((r) => { resolve = r }) })
    render(<Executors />)
    await screen.findByText('claude')
    fireEvent.click(screen.getByText('刷新'))
    expect(f.callsOf('executor.refresh')).toHaveLength(1)
    expect((screen.getByText('刷新') as HTMLButtonElement).disabled).toBe(true)
    await screen.findByText('刷新中')
    // 刷新中按第二次不重发(ref guard,防重复提交)
    fireEvent.click(screen.getByText('刷新'))
    expect(f.callsOf('executor.refresh')).toHaveLength(1)
    await act(async () => { resolve({ executors: [{ id: 'codex', installed: true, version: '2.0.0', auth: 'ok', isolation: 'own', missing: [] }] }) })
    await screen.findByText('codex')
    expect(screen.queryByText('claude')).toBeNull()
    expect(screen.queryByText('刷新中')).toBeNull()
  })

  it('a failed refresh shows 失败 and keeps the existing rows', async () => {
    f = installFakeForge({ calls: {
      'executor.list': { executors: [{ id: 'claude', installed: true, version: '1.0.0', auth: 'ok', isolation: 'own', missing: [] }] },
      'executor.refresh': () => fail(-32603, 'boom'),
    } })
    render(<Executors />)
    await screen.findByText('claude')
    fireEvent.click(screen.getByText('刷新'))
    await screen.findByText('失败')
    expect(screen.getByText('claude')).toBeInTheDocument()
    await waitFor(() => expect((screen.getByText('刷新') as HTMLButtonElement).disabled).toBe(false))
  })
})
