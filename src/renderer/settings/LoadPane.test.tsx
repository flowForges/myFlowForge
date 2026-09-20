import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LoadPane } from './LoadPane'
import type { Addon } from '@shared/addons'

/**
 * 加载项。这一屏的三个要害:**同一个技能在两个 CLI 下都要露面**、**筛得动**、
 * **删之前得说清是移到废纸篓还是真删**。
 */
const a = (over: Partial<Addon>): Addon => ({
  id: 'x', kind: 'skill', provider: 'claude', name: 'n', path: '/home/u/.claude/skills/n',
  installed: true, removable: true, removeVia: 'trash', description: '', ...over,
})
const ADDONS: Addon[] = [
  a({ id: 's1', name: 'writing-plans', provider: 'claude', path: '/home/u/.claude/skills/writing-plans' }),
  a({ id: 's2', name: 'writing-plans', provider: 'codex', path: '/home/u/.codex/skills/writing-plans' }),
  a({ id: 's3', name: 'brainstorming', provider: 'claude', path: '/home/u/.claude/plugins/x/skills/brainstorming', removable: false, removeVia: null, note: '属于插件包,要删就在 CLI 那边卸载整个插件' }),
  a({ id: 'r1', kind: 'rule', name: 'AGENTS.md', provider: 'codex', path: '/home/u/.codex/AGENTS.md', description: 'codex / qwen / agents 都读它' }),
  a({ id: 'm1', kind: 'mcp', name: 'sentry', provider: 'claude', path: '/home/u/.claude.json', removeVia: 'cli' }),
  a({ id: 's4', name: 'leftover', provider: 'qoder', path: '/home/u/.qoder/skills/leftover', installed: false }),
]

const lastConfirm = () => (window.confirm as unknown as { mock: { calls: string[][] } }).mock.calls.at(-1)![0]

const forge = {
  addonsScan: vi.fn(async () => ({ addons: ADDONS, home: '/home/u' })),
  addonsRemove: vi.fn(async () => ({ ok: true, trashed: true, via: 'file' as const })),
}
beforeEach(() => {
  forge.addonsScan.mockClear(); forge.addonsRemove.mockClear()
  forge.addonsScan.mockResolvedValue({ addons: ADDONS, home: '/home/u' })
  forge.addonsRemove.mockResolvedValue({ ok: true, trashed: true, via: 'file' })
  ;(globalThis as unknown as { window: { forge: unknown; confirm: unknown } }).window.forge = forge as never
  // ★spyOn 在同一个 window 上是**累积**的:不 clear 的话 calls[0] 是上一条测试留下的,
  //  于是「这一条弹了什么文案」验的是别人的调用。
  vi.spyOn(window, 'confirm').mockReturnValue(true).mockClear()
})

describe('列表', () => {
  it('★同一个技能在 claude 和 codex 各一条,两条都在(用户点名要的)', async () => {
    render(<LoadPane />)
    await waitFor(() => expect(screen.getAllByText('writing-plans').length).toBe(2))
  })

  it('按 provider 分组,卸载了的那个标出来', async () => {
    render(<LoadPane />)
    await screen.findByText('leftover')
    expect(screen.getByText('未检测到这个 CLI')).toBeTruthy()
  })

  it('三类都列,并且各自标了类型', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    expect(screen.getAllByText('Skill').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Rule').length).toBeGreaterThan(0)
    expect(screen.getAllByText('MCP').length).toBeGreaterThan(0)
  })
})

describe('筛选', () => {
  it('按类型筛', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getByText('Rule 1'))
    expect(screen.getByText('AGENTS.md')).toBeTruthy()
    expect(screen.queryByText('sentry')).toBeNull()
  })

  it('按 provider 筛', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    // ★「Codex」在分组头上也有一份,得按 chip 找 —— 不然 getByText 直接报 multiple elements。
    fireEvent.click([...document.querySelectorAll('.load-chip')].find(b => b.textContent === 'Codex')!)
    expect(screen.getByText('AGENTS.md')).toBeTruthy()
    expect(screen.queryByText('brainstorming')).toBeNull()
  })

  it('★关键词连**路径**一起搜 —— 「装在哪儿」常常是唯一记得住的线索', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.change(screen.getByPlaceholderText(/搜名字/), { target: { value: '.codex' } })
    expect(screen.getByText('AGENTS.md')).toBeTruthy()
    expect(screen.getAllByText('writing-plans').length).toBe(1)   // 只剩 codex 那条
    expect(screen.queryByText('sentry')).toBeNull()
  })

  it('筛没了要说「没有符合条件的」,而不是说「一个都没装」', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.change(screen.getByPlaceholderText(/搜名字/), { target: { value: '不存在的东西' } })
    expect(screen.getByText('没有符合条件的')).toBeTruthy()
  })
})

describe('删除', () => {
  it('★确认文案里写清是「移到废纸篓」还有路径 —— 点之前就该知道要动哪个文件', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getAllByText('删除')[0])
    await waitFor(() => expect(forge.addonsRemove).toHaveBeenCalledWith('s1'))
    expect(lastConfirm()).toContain('废纸篓')
    expect(lastConfirm()).toContain('/home/u/.claude/skills/writing-plans')
  })

  it('★MCP 的确认文案不一样(删的是配置里的一项,不是文件)', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    const row = screen.getByText('sentry').closest('.load-item')!
    fireEvent.click(row.querySelector('.load-del')!)
    await waitFor(() => expect(forge.addonsRemove).toHaveBeenCalledWith('m1'))
    expect(lastConfirm()).toContain('配置里删掉')
  })

  it('取消就什么都不做', async () => {
    ;(window.confirm as unknown as { mockReturnValue: (v: boolean) => void }).mockReturnValue(false)
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getAllByText('删除')[0])
    expect(forge.addonsRemove).not.toHaveBeenCalled()
  })

  it('删完重新扫一遍(不扫的话被删的那条还挂在屏幕上)', async () => {
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getAllByText('删除')[0])
    await waitFor(() => expect(forge.addonsScan).toHaveBeenCalledTimes(2))
  })

  it('★无头主机上没有废纸篓 → 回执要说明是直接删的,不能糊弄成"已移到废纸篓"', async () => {
    forge.addonsRemove.mockResolvedValue({ ok: true, trashed: false, via: 'file' })
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getAllByText('删除')[0])
    expect(await screen.findByText(/没有废纸篓/)).toBeTruthy()
  })

  it('★不能删的那条不给按钮,但**给理由**', async () => {
    render(<LoadPane />)
    const row = (await screen.findByText('brainstorming')).closest('.load-item')!
    expect(row.querySelector('.load-del')).toBeNull()
    expect(row.textContent).toContain('插件包')
  })

  it('删失败把原话摆出来', async () => {
    forge.addonsRemove.mockRejectedValue(new Error('EPERM: operation not permitted'))
    render(<LoadPane />)
    await screen.findByText('sentry')
    fireEvent.click(screen.getAllByText('删除')[0])
    expect(await screen.findByText(/EPERM/)).toBeTruthy()
  })
})
