import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PluginPane } from './PluginPane'
import type { InstalledPlugin, PluginResult, CatalogEntry } from '@shared/plugins'

const mockInstall = vi.fn()
const mockUninstall = vi.fn()
const mockSetEnabled = vi.fn()
const mockRefresh = vi.fn()
const mockInstallExample = vi.fn()
const mockSetCred = vi.fn()

const pluginA: InstalledPlugin = {
  id: 'plugin-a', dir: '/plugins/a', type: 'statusbar-usage', provider: 'claude',
  name: 'Claude Usage', entry: 'index.js', refreshSec: 60, enabled: true,
}
const pluginB: InstalledPlugin = {
  id: 'plugin-b', dir: '/plugins/b', type: 'other', provider: undefined,
  name: 'My Other Plugin', entry: 'run.sh', refreshSec: 120, enabled: false,
}
const resultA: PluginResult = { ok: true, type: 'statusbar-usage', data: {}, at: Date.now() - 5000 }
const resultErr: PluginResult = { ok: false, error: 'timeout error', at: Date.now() - 10000 }

const catalogClaude: CatalogEntry = {
  id: 'forge-example-claude-usage', name: 'Claude 额度（示例）', description: '演示用额度',
  icon: 'gauge', type: 'statusbar-usage', provider: 'claude', installed: false, available: true,
}
const catalogInstalled: CatalogEntry = { ...catalogClaude, id: 'forge-example-codex-usage', name: 'Codex 额度（示例）', installed: true }

function renderPane(opts: {
  plugins?: InstalledPlugin[]
  results?: Record<string, PluginResult>
  catalog?: CatalogEntry[]
  installError?: string | null
  creds?: Record<string, string>
} = {}) {
  return render(
    <PluginPane
      plugins={opts.plugins ?? []}
      results={opts.results ?? {}}
      catalog={opts.catalog ?? []}
      install={mockInstall}
      uninstall={mockUninstall}
      setEnabled={mockSetEnabled}
      refresh={mockRefresh}
      installExample={mockInstallExample}
      installError={opts.installError ?? null}
      creds={opts.creds ?? {}}
      setCred={mockSetCred}
    />,
  )
}

beforeEach(() => { vi.clearAllMocks() })

describe('PluginPane', () => {
  it('默认显示已安装 tab，空状态文案', () => {
    renderPane()
    expect(document.body.textContent).toMatch(/暂无已安装插件/)
  })

  it('上传插件 button calls install()', () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: /上传插件/ }))
    expect(mockInstall).toHaveBeenCalledTimes(1)
  })

  it('已安装行显示名称与友好类型', () => {
    renderPane({ plugins: [pluginA], results: { 'plugin-a': resultA } })
    expect(screen.getByText('Claude Usage')).toBeTruthy()
    expect(screen.getByText('状态栏额度显示')).toBeTruthy()
  })

  it('禁用按钮调用 setEnabled(id,false)', () => {
    renderPane({ plugins: [pluginA] })
    fireEvent.click(screen.getByRole('button', { name: /禁用/ }))
    expect(mockSetEnabled).toHaveBeenCalledWith('plugin-a', false)
  })

  it('启用按钮调用 setEnabled(id,true)', () => {
    renderPane({ plugins: [pluginB] })
    fireEvent.click(screen.getByRole('button', { name: /启用/ }))
    expect(mockSetEnabled).toHaveBeenCalledWith('plugin-b', true)
  })

  it('刷新按钮调用 refresh(id)', () => {
    renderPane({ plugins: [pluginA] })
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    expect(mockRefresh).toHaveBeenCalledWith('plugin-a')
  })

  it('卸载按钮调用 uninstall(id)', () => {
    renderPane({ plugins: [pluginA] })
    fireEvent.click(screen.getByRole('button', { name: /卸载/ }))
    expect(mockUninstall).toHaveBeenCalledWith('plugin-a')
  })

  it('未运行状态 pill', () => {
    renderPane({ plugins: [pluginA] })
    expect(screen.getByText('未运行')).toBeTruthy()
  })

  it('ok 结果状态 pill 带 .on', () => {
    const { container } = renderPane({ plugins: [pluginA], results: { 'plugin-a': resultA } })
    expect(container.querySelector('.plugin-status.on')).toBeTruthy()
  })

  it('禁用插件行带 .off', () => {
    const { container } = renderPane({ plugins: [pluginB] })
    expect(container.querySelector('.plugin-row.off')).toBeTruthy()
  })

  it('错误结果显示错误文案', () => {
    renderPane({ plugins: [pluginA], results: { 'plugin-a': resultErr } })
    expect(screen.getByText('timeout error')).toBeTruthy()
  })

  it('installError 显示', () => {
    renderPane({ installError: '清单无效' })
    expect(screen.getByText('清单无效')).toBeTruthy()
  })

  it('切到插件广场 tab 显示示例行 + 安装按钮调用 installExample', () => {
    renderPane({ catalog: [catalogClaude] })
    fireEvent.click(screen.getByRole('button', { name: /插件广场/ }))
    expect(screen.getByText('Claude 额度（示例）')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^安装$/ }))
    expect(mockInstallExample).toHaveBeenCalledWith('forge-example-claude-usage')
  })

  it('广场中已安装项显示「已安装」灰态，不显示安装按钮', () => {
    renderPane({ catalog: [catalogInstalled] })
    fireEvent.click(screen.getByRole('button', { name: '插件广场' }))
    expect(screen.getByText('已安装', { selector: '.plugin-installed' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^安装$/ })).toBeNull()
  })

  it('广场中 available=false 的项安装按钮禁用', () => {
    const catalogUnavailable: CatalogEntry = { ...catalogClaude, id: 'forge-example-x', name: 'X（示例）', available: false }
    renderPane({ catalog: [catalogUnavailable] })
    fireEvent.click(screen.getByRole('button', { name: '插件广场' }))
    const btn = screen.getByRole('button', { name: /^安装$/ })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })

  it('渲染 插件管理 标题', () => {
    renderPane()
    expect(screen.getByText('插件管理')).toBeTruthy()
  })

  it('原生额度插件显示「凭据」按钮，点开后保存调用 setCred(provider, value)', () => {
    renderPane({ plugins: [pluginA] })
    fireEvent.click(screen.getByRole('button', { name: /凭据/ }))
    const input = screen.getByPlaceholderText(/粘贴 token/)
    fireEvent.change(input, { target: { value: 'my-cookie' } })
    fireEvent.click(screen.getByRole('button', { name: /^保存$/ }))
    expect(mockSetCred).toHaveBeenCalledWith('claude', 'my-cookie')
  })

  it('无 provider 的插件不显示「凭据」按钮', () => {
    renderPane({ plugins: [pluginB] })
    expect(screen.queryByRole('button', { name: /凭据/ })).toBeNull()
  })
})
