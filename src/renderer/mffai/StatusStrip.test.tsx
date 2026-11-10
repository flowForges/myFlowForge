import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MffaiState, StatusResult } from '@mffai/protocol'
import { StatusStrip, type StripInfo } from './StatusStrip'

const base: MffaiState = { enabled: true, autostart: false, running: true, supervisor: { state: 'running', version: '0.1.0', restarts: 0, protocolVersion: 3 } }
const status = (p: Partial<StatusResult> = {}): StatusResult => ({ state: 'running', uptimeMs: 1, rssMb: 50, version: '0.1.0', plugins: [], ...p })
const strip = (state: Partial<MffaiState>, info?: StripInfo, h: Partial<{ onRestart: () => void; onResetTrip: () => void }> = {}) =>
  render(<StatusStrip state={{ ...base, ...state }} info={info} onRestart={h.onRestart ?? (() => {})} onResetTrip={h.onResetTrip ?? (() => {})} />)

describe('StatusStrip', () => {
  it('op set: 重新启动 is hidden (tripped, incompatible, gone)', () => {
    for (const s of [
      { supervisor: { ...base.supervisor!, state: 'tripped' as const }, running: false },
      { compatible: false },
      { supervisor: undefined, running: false },
    ]) {
      const r = strip({ ...s })
      expect(screen.getByText('重新启动')).toBeInTheDocument()
      r.unmount()
      const r2 = strip({ ...s, op: 'ensure' })
      expect(screen.queryByText('重新启动')).toBeNull()
      r2.unmount()
    }
  })

  it('proxyStale: 代理已改 chip, 重启 calls onRestart (the respawning host restart), hidden while op', () => {
    const onRestart = vi.fn(), onResetTrip = vi.fn()
    const r = strip({ proxyStale: true }, undefined, { onRestart, onResetTrip })
    expect(screen.getByText('代理已改')).toBeInTheDocument()
    fireEvent.click(screen.getByText('重启'))
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onResetTrip).not.toHaveBeenCalled()
    r.unmount()
    strip({ proxyStale: true, op: 'restart' })
    expect(screen.getByText('代理已改')).toBeInTheDocument()
    expect(screen.queryByText('重启')).toBeNull()
  })

  it('dev plugin: 开发插件 · 完全访问, always on; dev_crashed: 开发插件已跳过', () => {
    strip({}, { status: status({ plugins: [{ id: 'my-dev', state: 'active', trust: 'dev' }, { id: 'x', state: 'active' }], problems: ['dev_crashed'] }) })
    const dev = screen.getByText('开发插件 · 完全访问')
    expect(dev.getAttribute('title')).toBe('my-dev')
    expect(screen.getByText('开发插件已跳过')).toBeInTheDocument()
  })

  it('dbUnprotected and plaintext-file chips; absent when not set', () => {
    const r = strip({}, { status: status() })
    expect(screen.queryByText('数据库未收紧')).toBeNull()
    expect(screen.queryByText('明文存储')).toBeNull()
    expect(screen.queryByText('开发插件 · 完全访问')).toBeNull()
    r.unmount()
    strip({}, { status: status({ dbUnprotected: true, secretsBackend: 'plaintext-file' }) })
    expect(screen.getByText('数据库未收紧')).toBeInTheDocument()
    expect(screen.getByText('明文存储')).toBeInTheDocument()
  })

  it('sandbox level chip with the missing codes as title', () => {
    strip({}, { status: status({ sandbox: { level: 'partial', missing: ['proxy', 'netns'], autoDegraded: false } }) })
    expect(screen.getByText('部分').getAttribute('title')).toBe('proxy netns')
  })

  it('sandbox falls back to state.sandbox', () => {
    strip({ sandbox: { level: 'none', missing: ['platform'], autoDegraded: true } })
    expect(screen.getByText('未隔离')).toBeInTheDocument()
  })

  it('default model 账号 · 模型 and its quota windows; pending count', () => {
    strip({}, { model: { account: '主账号', model: 'GPT-5', quota: { windows: [{ label: '5h', usedPercent: 40 }, { label: '7d', usedPercent: 12 }] } }, pending: 2 })
    expect(screen.getByText('主账号 · GPT-5')).toBeInTheDocument()
    expect(screen.getByText('5h 40%')).toBeInTheDocument()
    expect(screen.getByText('7d 12%')).toBeInTheDocument()
    expect(screen.getByText('待处理 2')).toBeInTheDocument()
  })

  it('no pending -> no chip', () => {
    strip({}, { pending: 0 })
    expect(screen.queryByText(/待处理/)).toBeNull()
  })

  it('未设模型: only once status has loaded and there is no default model', () => {
    const r = strip({})
    expect(screen.queryByText('未设模型')).toBeNull()
    r.unmount()
    const r2 = strip({}, { status: status() })
    expect(screen.getByText('未设模型')).toBeInTheDocument()
    r2.unmount()
    strip({}, { status: status(), model: { account: 'Claude', model: 'Sonnet' } })
    expect(screen.queryByText('未设模型')).toBeNull()
    expect(screen.getByText('Claude · Sonnet')).toBeInTheDocument()
  })
})
