import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { McpPanel } from './McpPanel'
import type { McpProviderView } from '@shared/mcp'

/**
 * MCP 面板。这一屏的**全部价值**在授权那条路上,而那条路有三个各自会静默出错的地方:
 *  ① 授权链接要在**这台设备**上打开(`openExternal` 是 CLIENT_ONLY),不是在主机上;
 *  ② 面板关掉 / 行卸载时必须把主机上那个 `mcp login` 进程杀掉(它会一直挂着等回调);
 *  ③ 客户端就是主机时**根本不用粘**,回调自己完成 —— 界面得认这条路。
 */

const caps = { mcp: true, list: true, login: true, logout: true, json: false, noBrowser: true }
const view = (over: Partial<McpProviderView> = {}): McpProviderView => ({
  providerId: 'claude', displayName: 'Claude Code', caps,
  servers: [
    { name: 'sentry', target: 'https://mcp.sentry.dev/mcp', auth: 'needs-auth', detail: '! Needs authentication' },
    { name: 'gdrive', target: 'https://drive/mcp', auth: 'connected', detail: '✔ Connected' },
  ],
  error: null,
  ...over,
})

const forge = {
  mcpOverview: vi.fn(async () => [view()]),
  mcpLoginStart: vi.fn(async () => ({ id: 'mcp-1', url: 'https://auth.example/authorize?x=1', needsPaste: true, outcome: null, text: '' })),
  mcpLoginPaste: vi.fn(async () => ({ outcome: 'ok' as const, text: 'Authentication successful' })),
  mcpLoginWait: vi.fn(() => new Promise(() => {})),   // 默认永不回:模拟"还在等回调"
  mcpLoginCancel: vi.fn(async () => {}),
  mcpLogout: vi.fn(async () => ({ stdout: '', code: 0 })),
  openExternal: vi.fn(async () => ({ ok: true })),
}
beforeEach(() => {
  for (const f of Object.values(forge)) (f as ReturnType<typeof vi.fn>).mockClear?.()
  forge.mcpOverview.mockResolvedValue([view()])
  forge.mcpLoginWait.mockImplementation(() => new Promise(() => {}))
  ;(globalThis as unknown as { window: { forge: unknown } }).window.forge = forge as never
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } })
})

describe('列表', () => {
  it('列出服务器和状态,连上的给「取消授权」、待授权的给「授权」', async () => {
    render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    expect(screen.getByText('待授权')).toBeTruthy()
    expect(screen.getByText('已连接')).toBeTruthy()
    expect(screen.getByText('授权')).toBeTruthy()
    expect(screen.getByText('取消授权')).toBeTruthy()
  })

  it('★带上工作区目录 —— 项目级(.mcp.json)的服务器只在那个目录里看得见', async () => {
    render(<McpPanel workspacePath="/ws/alpha" onClose={() => {}} />)
    await screen.findByText('sentry')
    expect(forge.mcpOverview).toHaveBeenCalledWith('/ws/alpha')
  })

  it('★没有 mcp 子命令的 CLI 也列出来并说明原因,而不是留一片空白', async () => {
    forge.mcpOverview.mockResolvedValue([
      { providerId: 'cursor', displayName: 'Cursor', caps: { ...caps, mcp: false, list: false, login: false }, servers: [], error: null },
    ])
    render(<McpPanel onClose={() => {}} />)
    expect(await screen.findByText(/这个版本没有 mcp 子命令/)).toBeTruthy()
  })

  it('★单个 provider 出错只显示在它自己那一段,不把整块面板变成一句报错', async () => {
    forge.mcpOverview.mockResolvedValue([view({ error: '健康检查超时' }), view({ providerId: 'codex', displayName: 'Codex' })])
    render(<McpPanel onClose={() => {}} />)
    expect(await screen.findByText('健康检查超时')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
  })
})

describe('授权', () => {
  it('★链接在**这台设备**上打开(openExternal 是 CLIENT_ONLY),而 login 跑在主机上', async () => {
    render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('授权'))
    await waitFor(() => expect(forge.openExternal).toHaveBeenCalledWith('https://auth.example/authorize?x=1'))
    expect(forge.mcpLoginStart).toHaveBeenCalledWith({ providerId: 'claude', workspacePath: undefined, name: 'sentry' })
  })

  it('★粘回地址 → 成功 → 列表**重新拉一次**(不刷新的话状态还停在「待授权」)', async () => {
    render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('授权'))
    const input = await screen.findByPlaceholderText(/localhost/)
    fireEvent.change(input, { target: { value: 'http://localhost:3118/callback?code=abc' } })
    fireEvent.click(screen.getByText('提交'))
    await waitFor(() => expect(forge.mcpLoginPaste).toHaveBeenCalledWith({ id: 'mcp-1', redirectUrl: 'http://localhost:3118/callback?code=abc' }))
    await screen.findByText('授权成功')
    expect(forge.mcpOverview).toHaveBeenCalledTimes(2)
  })

  it('★客户端就是主机时 localhost 回调自己完成 —— 不用粘任何东西', async () => {
    forge.mcpLoginWait.mockResolvedValue({ outcome: 'ok', text: 'Authentication successful' } as never)
    render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('授权'))
    await screen.findByText('授权成功')
    expect(forge.mcpLoginPaste).not.toHaveBeenCalled()
  })

  it('★面板关掉要把主机上那个 login 进程杀掉 —— 不杀就是个一直等回调的孤儿', async () => {
    const { unmount } = render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('授权'))
    await screen.findByPlaceholderText(/localhost/)
    unmount()
    await waitFor(() => expect(forge.mcpLoginCancel).toHaveBeenCalledWith('mcp-1'))
  })

  it('CLI 不打印链接时说清楚「浏览器开在主机那台上」,而不是干等着', async () => {
    forge.mcpLoginStart.mockResolvedValue({ id: 'mcp-2', url: null, needsPaste: false, outcome: null, text: '' } as never)
    render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('授权'))
    expect(await screen.findByText(/主机那台机器/)).toBeTruthy()
    expect(forge.openExternal).not.toHaveBeenCalled()
  })

  it('失败时把 CLI 原话摆出来', async () => {
    forge.mcpLoginStart.mockResolvedValue({ id: 'mcp-3', url: null, needsPaste: false, outcome: 'fail', text: "Couldn't complete authentication" } as never)
    render(<McpPanel onClose={() => {}} />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('授权'))
    expect(await screen.findByText(/Couldn't complete authentication/)).toBeTruthy()
  })
})

describe('取消授权', () => {
  it('调 mcpLogout 并刷新', async () => {
    render(<McpPanel workspacePath="/ws" onClose={() => {}} />)
    await screen.findByText('gdrive')
    fireEvent.click(screen.getByText('取消授权'))
    await waitFor(() => expect(forge.mcpLogout).toHaveBeenCalledWith({ providerId: 'claude', workspacePath: '/ws', name: 'gdrive' }))
    await screen.findByText('已取消授权')
    expect(forge.mcpOverview).toHaveBeenCalledTimes(2)
  })
})
