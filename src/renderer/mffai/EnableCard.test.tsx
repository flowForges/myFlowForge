import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { EnableCard, type EnableCardProps } from './EnableCard'

const roots = { data: '/h/.myFlowForge/mff-ai', worktrees: '/h/.myFlowForge/mff-ai-worktrees', imWorktrees: '/h/.myFlowForge/mff-ai-im', plugins: '/h/.myFlowForge/mff-ai-plugins', keychain: 'myflowforge-mffai/ab12cd34' }
const card = (p: Partial<EnableCardProps> = {}) => render(
  <EnableCard expectedRssMb={110} dataDir={roots.data} autostart={false} onToggleAutostart={() => {}} onEnable={() => {}} onWipe={async () => ({ ok: true })} {...p} />,
)

describe('EnableCard delete-all', () => {
  it('hidden without dataExists, and without roots', () => {
    const r = card({ roots })
    expect(screen.queryByText('删除全部数据')).toBeNull()
    r.unmount()
    card({ dataExists: true })
    expect(screen.queryByText('删除全部数据')).toBeNull()
  })

  it('with an owned LaunchAgent plist present, the confirm lists it after the keychain entry; without it there is no such row', () => {
    const plist = '/h/Library/LaunchAgents/com.myflowforge.mffai.plist'
    const r = card({ dataExists: true, roots: { ...roots, launchAgent: plist } })
    fireEvent.click(screen.getByText('删除全部数据'))
    const rows = () => [...screen.getByRole('dialog').querySelectorAll('.mffai-confirm-row')].map((x) => [...x.children].map((c) => c.textContent))
    expect(rows().slice(4, 6)).toEqual([['钥匙串条目', roots.keychain], ['LaunchAgent', plist]])
    r.unmount()
    card({ dataExists: true, roots })
    fireEvent.click(screen.getByText('删除全部数据'))
    expect(rows().some(([k]) => k === 'LaunchAgent')).toBe(false)
  })

  it('confirm lists the four paths, the keychain entry and the three 保留 rows, then wipes', async () => {
    const onWipe = vi.fn(async () => ({ ok: true as const }))
    card({ dataExists: true, roots, onWipe })
    fireEvent.click(screen.getByText('删除全部数据'))
    const dlg = screen.getByRole('dialog')
    const rows = [...dlg.querySelectorAll('.mffai-confirm-row')].map((r) => [...r.children].map((c) => c.textContent))
    expect(rows).toEqual([
      ['数据目录', roots.data],
      ['委派 worktree', roots.worktrees],
      ['IM worktree', roots.imWorktrees],
      ['插件代码', roots.plugins],
      ['钥匙串条目', roots.keychain],
      ['保留', '仓库里的 refs/mffai 快照引用'],
      ['保留', '仓库里的 worktree 登记'],
      ['保留', 'Telegram 机器人令牌'],
    ])
    await vi.waitFor(() => expect(within(dlg).getByRole('button', { name: '删除全部数据' })).toBeInTheDocument())
    fireEvent.click(within(dlg).getByRole('button', { name: '删除全部数据' }))
    expect(onWipe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a refused wipe shows 失败 with the reason code', async () => {
    card({ dataExists: true, roots, onWipe: async () => ({ ok: false, reason: 'running' }) })
    fireEvent.click(screen.getByText('删除全部数据'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除全部数据' }))
    expect(await screen.findByText('running')).toBeInTheDocument()
    expect(screen.getByText('失败')).toBeInTheDocument()
  })

  it('cancel closes without wiping', () => {
    const onWipe = vi.fn(async () => ({ ok: true as const }))
    card({ dataExists: true, roots, onWipe })
    fireEvent.click(screen.getByText('删除全部数据'))
    fireEvent.click(screen.getByText('取消'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onWipe).not.toHaveBeenCalled()
  })
})
