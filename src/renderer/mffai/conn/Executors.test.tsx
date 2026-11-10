import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ExecutorListResult } from '@mffai/protocol'
import { Executors } from './Executors'
import { fail, installFakeForge, type FakeForge } from '../test/fakeForge'

let f: FakeForge
afterEach(() => vi.restoreAllMocks())

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
  it('executor.list answering -32601 shows 不支持, no 刷新 and no console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    f = installFakeForge({ calls: { 'executor.list': () => fail(-32601, 'method not found') } })
    render(<Executors />)
    expect(await screen.findByText('不支持')).toBeInTheDocument()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.queryByText('刷新')).toBeNull()
    expect(err).not.toHaveBeenCalled()
  })

  it('executor.refresh answering -32601 shows 不支持 (not 失败), keeps the rows, no console.error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    f = installFakeForge({ calls: {
      'executor.list': { executors: [{ id: 'claude', installed: true, version: '1.0.0', auth: 'ok', isolation: 'own', missing: [] }] },
      'executor.refresh': () => fail(-32601, 'method not found'),
    } })
    render(<Executors />)
    await screen.findByText('claude')
    await act(async () => { fireEvent.click(screen.getByText('刷新')) })
    expect(await screen.findByText('不支持')).toBeInTheDocument()
    expect(screen.queryByText('失败')).toBeNull()
    expect(screen.getByText('claude')).toBeInTheDocument()
    expect(err).not.toHaveBeenCalled()
  })

  it('a table: columns 执行器 / 安装 / 登录 / 隔离 / 缺少, a logo tile per row, header count and a refresh button with a spinner while loading', async () => {
    let resolve!: (v: ExecutorListResult) => void
    f = installFakeForge({ calls: {
      'executor.list': { executors: [
        { id: 'claude', installed: true, version: '1.2.3', auth: 'ok', isolation: 'own', missing: [] },
        { id: 'codex', installed: false, auth: 'missing', isolation: 'none', missing: ['codex_network'] },
        { id: 'gemini', installed: false, auth: 'unknown', isolation: 'none', missing: [] },
      ] },
    } })
    f.script({ 'executor.refresh': () => new Promise<ExecutorListResult>((r) => { resolve = r }) })
    render(<Executors />)
    await screen.findByText('claude')
    expect([...document.querySelectorAll('table.mffai-tbl th')].map((n) => n.textContent)).toEqual(['执行器', '安装', '登录', '隔离', '缺少'])
    const rows = document.querySelectorAll('tr[data-executor]')
    expect(rows).toHaveLength(3)
    expect(rows[0].querySelector('.mffai-rlogo')).toHaveClass('cc')
    expect(rows[1].querySelector('.mffai-rlogo')).toHaveClass('cx')
    expect(rows[2].querySelector('.mffai-rlogo')).toHaveClass('gm')
    const head = document.querySelector('.mffai-sech') as HTMLElement
    expect(head).toHaveTextContent('执行器')
    expect(within(head).getByText('3')).toBeInTheDocument()
    expect(document.querySelector('.mffai-spin')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(document.querySelector('button .mffai-spin')).not.toBeNull()
    await act(async () => { resolve({ executors: [] }) })
    await waitFor(() => expect(document.querySelector('.mffai-spin')).toBeNull())
  })
})
