import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DebugLogPane } from './DebugLogPane'
import type { AppLogEntry } from '@shared/types'

const get = vi.fn(); const clear = vi.fn(); const exportLog = vi.fn(); let emit: (e: AppLogEntry) => void
const onEvent = vi.fn((cb: (e: AppLogEntry) => void) => { emit = cb; return () => {} })

const E = (level: AppLogEntry['level'], scope: string, msg: string, detail?: string): AppLogEntry =>
  ({ ts: '2026-06-30T18:00:00.000Z', level, scope, msg, ...(detail ? { detail } : {}) })

beforeEach(() => {
  get.mockResolvedValue([E('info', 'app', '启动 myFlowForge'), E('error', 'codex', 'chat 退出码 2', 'stderr: boom')])
  clear.mockResolvedValue([])
  exportLog.mockResolvedValue({ ok: true, path: '/tmp/x.log' })
  ;(globalThis as any).window.forge = { appLogGet: get, appLogClear: clear, appLogExport: exportLog, onAppLogEvent: onEvent }
})

describe('DebugLogPane', () => {
  it('loads and renders existing log entries', async () => {
    render(<DebugLogPane />)
    expect(await screen.findByText('启动 myFlowForge')).toBeInTheDocument()
    expect(screen.getByText('chat 退出码 2')).toBeInTheDocument()
    expect(screen.getByText('stderr: boom')).toBeInTheDocument()
  })

  it('filters by level (错误 hides info entries)', async () => {
    render(<DebugLogPane />)
    await screen.findByText('启动 myFlowForge')
    fireEvent.click(screen.getByRole('button', { name: '错误' }))
    expect(screen.queryByText('启动 myFlowForge')).not.toBeInTheDocument()
    expect(screen.getByText('chat 退出码 2')).toBeInTheDocument()
  })

  it('renders timestamps as local time, not raw UTC slice', async () => {
    render(<DebugLogPane />)
    await screen.findByText('启动 myFlowForge')
    const d = new Date('2026-06-30T18:00:00.000Z')
    const p = (n: number) => String(n).padStart(2, '0')
    const local = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    const tsEls = document.querySelectorAll('.dl-ts')
    expect(tsEls.length).toBeGreaterThan(0)
    for (const el of tsEls) expect(el.textContent).toBe(local)
  })

  it('appends live entries from onAppLogEvent', async () => {
    render(<DebugLogPane />)
    await screen.findByText('启动 myFlowForge')
    emit(E('warn', 'reconcile', '启动对账失败'))
    expect(await screen.findByText('启动对账失败')).toBeInTheDocument()
  })

  it('clear empties the list', async () => {
    render(<DebugLogPane />)
    await screen.findByText('启动 myFlowForge')
    fireEvent.click(screen.getByRole('button', { name: '清空' }))
    await waitFor(() => expect(screen.queryByText('启动 myFlowForge')).not.toBeInTheDocument())
    expect(clear).toHaveBeenCalled()
  })

  it('export calls the IPC bridge', async () => {
    render(<DebugLogPane />)
    await screen.findByText('启动 myFlowForge')
    fireEvent.click(screen.getByRole('button', { name: '导出日志' }))
    expect(exportLog).toHaveBeenCalled()
  })
})
