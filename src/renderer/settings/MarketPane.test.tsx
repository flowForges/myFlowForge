import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MarketPane } from './MarketPane'
import type { CliPluginView } from '@shared/cliPlugins'

const caps = { plugin: true, list: true, json: true, available: true, installVerb: 'install', removeVerb: 'uninstall', marketplace: true }
const codexCaps = { ...caps, installVerb: 'add', removeVerb: 'remove' }

const VIEWS: CliPluginView[] = [
  {
    providerId: 'claude', displayName: 'Claude Code', caps, error: null,
    plugins: [
      { id: 'superpowers@official', name: 'superpowers', description: '一堆技能', marketplace: 'official', version: '6.3.0', installed: true, installs: 90000 },
      { id: 'adobe@official', name: 'adobe-for-creativity', description: 'Adobe 那套', marketplace: 'official', version: '', installed: false, installs: 120 },
    ],
  },
  {
    providerId: 'codex', displayName: 'Codex', caps: codexCaps, error: null,
    plugins: [{ id: 'latex@openai-bundled', name: 'latex', description: '', marketplace: 'openai-bundled', version: '0.2.6', installed: false }],
  },
  { providerId: 'cursor', displayName: 'Cursor', caps: { ...caps, plugin: false, list: false }, plugins: [], error: null },
]

const forge = {
  cliPluginsList: vi.fn(async () => VIEWS),
  cliPluginsInstall: vi.fn(async () => 'Installed. Restart Claude Code to apply.'),
  cliPluginsUninstall: vi.fn(async () => 'Uninstalled.'),
}
beforeEach(() => {
  for (const f of Object.values(forge)) f.mockClear()
  forge.cliPluginsList.mockResolvedValue(VIEWS)
  ;(globalThis as unknown as { window: { forge: unknown } }).window.forge = forge as never
  vi.spyOn(window, 'confirm').mockReturnValue(true).mockClear()
})

describe('列表', () => {
  it('按 CLI 分栏,只列有插件市场的那几个', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    expect(screen.getByText('Claude Code 2')).toBeTruthy()
    expect(screen.getByText('Codex 1')).toBeTruthy()
    expect(screen.queryByText(/Cursor/)).toBeNull()   // 没有 plugin 子命令的不摆
  })

  it('已安装的标出来,并给「卸载」;没装的给「安装」', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    expect(screen.getByText('已安装')).toBeTruthy()
    expect(screen.getByText('卸载')).toBeTruthy()
    expect(screen.getByText('安装')).toBeTruthy()
  })

  it('安装量和市场名都显示', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    expect(screen.getByText(/90,000 次安装/)).toBeTruthy()
  })

  it('★codex 的条目没有说明 —— 少画一行,不编', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('Codex 1'))
    const row = (await screen.findByText('latex')).closest('.mk-item')!
    expect(row.querySelector('.d')).toBeNull()
    expect(row.querySelector('.s')!.textContent).toContain('openai-bundled')
  })
})

describe('筛选', () => {
  it('已安装 / 可安装', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('可安装'))
    expect(screen.queryByText('superpowers')).toBeNull()
    expect(screen.getByText('adobe-for-creativity')).toBeTruthy()
  })
  it('搜名字和说明', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.change(screen.getByPlaceholderText(/搜插件名/), { target: { value: 'Adobe 那套' } })
    expect(screen.getByText('adobe-for-creativity')).toBeTruthy()
    expect(screen.queryByText('superpowers')).toBeNull()
  })
})

describe('装 / 卸', () => {
  it('★点安装 → 带上当前这一栏的 provider(装到哪个 CLI 上是这一屏最要紧的一件事)', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('安装'))
    await waitFor(() => expect(forge.cliPluginsInstall).toHaveBeenCalledWith({ providerId: 'claude', id: 'adobe@official' }))
  })

  it('★切到 codex 之后装的是 codex', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('Codex 1'))
    fireEvent.click(await screen.findByText('安装'))
    await waitFor(() => expect(forge.cliPluginsInstall).toHaveBeenCalledWith({ providerId: 'codex', id: 'latex@openai-bundled' }))
  })

  it('★装完把 CLI 的原话摆出来 —— 「要重启才生效」这种只有它自己知道', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('安装'))
    expect(await screen.findByText(/Restart Claude Code to apply/)).toBeTruthy()
  })

  it('装完重新拉一次列表(不拉的话按钮还写着「安装」)', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('安装'))
    await waitFor(() => expect(forge.cliPluginsList).toHaveBeenCalledTimes(2))
  })

  it('卸载要先确认', async () => {
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('卸载'))
    await waitFor(() => expect(forge.cliPluginsUninstall).toHaveBeenCalled())
    expect(window.confirm).toHaveBeenCalled()
  })

  it('取消确认就不卸', async () => {
    ;(window.confirm as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(false)
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('卸载'))
    expect(forge.cliPluginsUninstall).not.toHaveBeenCalled()
  })

  it('失败把原话摆出来', async () => {
    forge.cliPluginsInstall.mockRejectedValue(new Error('Error: plugin not found in any marketplace'))
    render(<MarketPane />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByText('安装'))
    expect(await screen.findByText(/not found in any marketplace/)).toBeTruthy()
  })

  it('★这个版本没有安装动词时不摆按钮,而是说清楚', async () => {
    forge.cliPluginsList.mockResolvedValue([{ ...VIEWS[0], caps: { ...caps, installVerb: null } }])
    render(<MarketPane />)
    await screen.findByText('adobe-for-creativity')
    expect(screen.getByText('这个版本不支持安装')).toBeTruthy()
  })
})

describe('空 / 错', () => {
  it('一个有市场的 CLI 都没有 → 说清楚', async () => {
    forge.cliPluginsList.mockResolvedValue([VIEWS[2]])
    render(<MarketPane />)
    expect(await screen.findByText(/都没有插件市场/)).toBeTruthy()
  })
  it('某个 CLI 单独出错只显示在它那一栏', async () => {
    forge.cliPluginsList.mockResolvedValue([{ ...VIEWS[0], error: '市场拉取超时' }])
    render(<MarketPane />)
    expect(await screen.findByText('市场拉取超时')).toBeTruthy()
  })
})
