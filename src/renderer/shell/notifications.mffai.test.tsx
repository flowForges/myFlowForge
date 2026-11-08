// 铃铛给 mff-ai 加的可选字段(08 §13.6):key 原地替换/移除,actions 渲染按钮,onOpen 点击时先调。
// 没有这些字段的通知,弹层输出和改之前逐字相同(基线是改之前抓下来的 innerHTML)。
import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { NotificationPopover } from './NotificationPopover'
import { removeNotif, upsertNotif, type Notif } from './notifications'
import { MOCK_NOTIFS } from './notifications.fixtures'

const base = { updateAvailable: false, open: true, onToggle: () => {}, onOpenUpgrade: () => {}, onMarkAllRead: () => {}, onClearAll: () => {} }

const n = (t: string, extra: Partial<Notif> = {}): Notif => ({ ic: 'warn', cls: 'ni-warn', t, m: '', unread: true, ...extra })

describe('upsertNotif / removeNotif', () => {
  it('replaces by key in place, otherwise prepends; remove drops only that key', () => {
    const a = n('a', { key: 'k1' }), b = n('b'), c = n('c', { key: 'k2' })
    let ns = [a, b, c]
    ns = upsertNotif(ns, n('a2', { key: 'k1' }))
    expect(ns.map((x) => x.t)).toEqual(['a2', 'b', 'c'])
    ns = upsertNotif(ns, n('d', { key: 'k3' }))
    expect(ns.map((x) => x.t)).toEqual(['d', 'a2', 'b', 'c'])
    ns = upsertNotif(ns, n('e'))
    expect(ns.map((x) => x.t)).toEqual(['e', 'd', 'a2', 'b', 'c'])
    expect(removeNotif(ns, 'k1').map((x) => x.t)).toEqual(['e', 'd', 'b', 'c'])
    expect(removeNotif(ns, 'nope')).toBe(ns)
  })
})

describe('NotificationPopover with mff-ai fields', () => {
  it('a list without actions renders exactly as before the change', () => {
    const { container } = render(<NotificationPopover {...base} notifs={MOCK_NOTIFS} onSelect={() => {}} />)
    expect(container.querySelector('.notif-list')!.innerHTML).toMatchInlineSnapshot(`"<div class="notif-item unread" role="button" tabindex="0"><div class="ni-ic ni-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"></polyline></svg></div><div class="ni-b"><div class="ni-t"><b>design-system-v3</b> 的代码 Review 阶段已完成</div><div class="ni-m">Reviewer · 2 分钟前</div></div></div><div class="notif-item unread" role="button" tabindex="0"><div class="ni-ic ni-file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></div><div class="ni-b"><div class="ni-t"><b>api-gateway</b> 有 11 个文件变更待查看</div><div class="ni-m">文件追踪 · 14 分钟前</div></div></div><div class="notif-item" role="button" tabindex="0"><div class="ni-ic ni-warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg></div><div class="ni-b"><div class="ni-t"><b>部署代理</b> 在等待你确认目标分支</div><div class="ni-m">需要操作 · 23 分钟前</div></div></div><div class="notif-item" role="button" tabindex="0"><div class="ni-ic ni-ok"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="20 6 9 17 4 12"></polyline></svg></div><div class="ni-b"><div class="ni-t">工作区 <b>mobile-redesign</b> 全部阶段执行完毕</div><div class="ni-m">编排 · 1 小时前</div></div></div>"`)
  })

  it('action buttons render, fire their run, and do not select the row', () => {
    const allow = vi.fn(), deny = vi.fn(), onSelect = vi.fn()
    render(<NotificationPopover {...base} onSelect={onSelect} notifs={[
      n('<b>shell</b> 待审批', { key: 'a1', actions: [{ label: '允许', run: allow }, { label: '拒绝', run: deny, danger: true }] }),
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(allow).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    const d = screen.getByRole('button', { name: '拒绝' })
    expect(d.className).toContain('danger')
    fireEvent.click(d)
    expect(deny).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a notification with onOpen is styled as navigating', () => {
    const { container } = render(<NotificationPopover {...base} onSelect={() => {}} notifs={[n('x', { onOpen: () => {} })]} />)
    expect(container.querySelector('.notif-item')!.className).toContain('clickable')
  })
})
