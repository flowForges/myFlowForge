import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NotificationPopover } from './NotificationPopover'
import { formatBytes, releaseSummary } from './notifications'
import { MOCK_NOTIFS } from './notifications.fixtures'

function setup(over: Partial<Parameters<typeof NotificationPopover>[0]> = {}) {
  const props = {
    notifs: MOCK_NOTIFS,
    updateAvailable: true,
    open: true,
    onToggle: vi.fn(),
    onOpenUpgrade: vi.fn(),
    onMarkAllRead: vi.fn(),
    onClearAll: vi.fn(),
    ...over,
  }
  render(<NotificationPopover {...props} />)
  return props
}

const INFO = { version: '2.4.0', notes: '## v2.4.0\n工作流混合编排、文件树提速', dmgUrl: 'u', dmgSize: 26214400, dmgName: 'a.dmg' }

describe('formatBytes / releaseSummary', () => {
  it('formats MB to one decimal', () => { expect(formatBytes(26214400)).toBe('25.0 MB') })
  it('takes the first meaningful line without markdown #', () => {
    expect(releaseSummary('## v2.4.0\n工作流混合编排')).toBe('工作流混合编排')
  })
})

describe('NotificationPopover update block', () => {
  const props = { notifs: [], updateAvailable: true, info: INFO, open: true, onToggle: () => {}, onOpenUpgrade: () => {}, onMarkAllRead: () => {}, onClearAll: () => {} }
  it('renders the real version and size from info', () => {
    render(<NotificationPopover {...props} />)
    expect(screen.getByText(/Forge v2\.4\.0/)).toBeTruthy()
    expect(screen.getByText(/25\.0 MB/)).toBeTruthy()
  })
  it('hides the update block when no info', () => {
    const { container } = render(<NotificationPopover {...props} updateAvailable={false} info={null} />)
    expect(container.querySelector('.notif-up')).toBeNull()
  })

  // Regression: fresh install badge-but-blank. updateAvailable lights the badge, so the
  // card must render even when info is missing (no more phantom badge over an empty popover).
  it('renders a graceful update card when updateAvailable but info is missing', () => {
    const { container } = render(
      <NotificationPopover notifs={[]} updateAvailable info={null} open onToggle={() => {}} onOpenUpgrade={() => {}} onMarkAllRead={() => {}} onClearAll={() => {}} />,
    )
    expect(container.querySelector('.notif-up')).not.toBeNull()
    expect(screen.getByText('有可用更新')).toBeTruthy()
    expect(screen.getByText('查看并升级')).toBeTruthy()
    // Must NOT show garbage from blind field reads.
    expect(container.textContent).not.toMatch(/undefined|NaN/)
  })

  it('any badge means the popover is never empty (badge/content invariant)', () => {
    // updateAvailable + no info + no notifs = the exact fresh-install failure mode.
    const { container } = render(
      <NotificationPopover notifs={[]} updateAvailable info={null} open onToggle={() => {}} onOpenUpgrade={() => {}} onMarkAllRead={() => {}} onClearAll={() => {}} />,
    )
    const badge = container.querySelector('.nb-badge')?.textContent
    expect(badge).not.toBe('0')
    // Something meaningful beyond the header/empty-state is present.
    expect(container.querySelector('.notif-up')).not.toBeNull()
  })
})

describe('NotificationPopover', () => {
  it('renders the bell button with title 通知', () => {
    setup()
    expect(screen.getByTitle('通知')).toBeInTheDocument()
  })

  it('when open + updateAvailable + info renders 查看并升级 and 4 notif items', () => {
    setup({ info: INFO })
    expect(screen.getByText('查看并升级')).toBeInTheDocument()
    expect(document.body.querySelectorAll('.ni-t')).toHaveLength(4)
  })

  it('clicking 全部已读 calls onMarkAllRead', () => {
    const props = setup()
    fireEvent.click(screen.getByText('全部已读'))
    expect(props.onMarkAllRead).toHaveBeenCalledTimes(1)
  })

  it('clicking 清空 calls onClearAll (empties the list)', () => {
    const props = setup()
    fireEvent.click(screen.getByText('清空'))
    expect(props.onClearAll).toHaveBeenCalledTimes(1)
  })

  it('hides 清空 when there are no notifs to clear', () => {
    setup({ notifs: [] })
    expect(screen.queryByText('清空')).not.toBeInTheDocument()
  })

  it('clicking 查看并升级 calls onOpenUpgrade', () => {
    const props = setup({ info: INFO })
    fireEvent.click(screen.getByText('查看并升级'))
    expect(props.onOpenUpgrade).toHaveBeenCalledTimes(1)
  })

  it('clicking the bell calls onToggle', () => {
    const props = setup({ open: false })
    fireEvent.click(screen.getByTitle('通知'))
    expect(props.onToggle).toHaveBeenCalledTimes(1)
  })

  it('hides the upgrade block when updateAvailable is false', () => {
    setup({ updateAvailable: false, info: INFO })
    expect(screen.queryByText('查看并升级')).not.toBeInTheDocument()
  })
})
