import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AppIconPane } from './AppIconPane'
import { NotificationsPane } from './NotificationsPane'

// 这两个面板的文案里写死了 macOS 的名词。Windows 上「Dock」「顶部状态栏」都不存在,照着说就是在骗人 ——
// 而且「缩小到 Dock」在 Windows 上真正发生的事是收进托盘,托盘关着时还只能最小化。
function withPlatform(platform: string, fn: () => void) {
  const prev = (window as any).forge
  ;(window as any).forge = { ...(prev ?? {}), platform, getAppIconOptions: async () => [] }
  try { fn() } finally { (window as any).forge = prev; cleanup() }
}

const appIcon = { dockIcon: 'ember-violet' as const, showMenuBar: false }

afterEach(cleanup)

describe('AppIconPane 文案', () => {
  it('macOS:说 Dock 和顶部状态栏', () => {
    withPlatform('darwin', () => {
      render(<AppIconPane appIcon={appIcon} onChange={() => {}} />)
      expect(screen.getByText('Dock 图标')).toBeInTheDocument()
      expect(screen.getByText(/顶部状态栏/)).toBeInTheDocument()
    })
  })

  it('Windows:说托盘/通知区域,不再出现 Dock 或「顶部状态栏」', () => {
    withPlatform('win32', () => {
      const { container } = render(<AppIconPane appIcon={appIcon} onChange={() => {}} />)
      expect(container.textContent).not.toMatch(/Dock/)
      expect(container.textContent).not.toMatch(/顶部状态栏/)
      expect(container.textContent).toMatch(/通知区域/)
    })
  })

  // Windows 上这个图标选择器不再是死的:它决定托盘显示哪一个图标。
  it('Windows:图标选择器仍在(它驱动托盘图标)', () => {
    withPlatform('win32', () => {
      const { container } = render(<AppIconPane appIcon={appIcon} onChange={() => {}} />)
      expect(container.querySelectorAll('.app-icon-choice').length).toBeGreaterThan(0)
    })
  })
})

describe('NotificationsPane 关闭行为文案', () => {
  const props = {
    notifications: { confirm: true, input: true, done: true } as any,
    onNotificationsChange: () => {},
    closeAction: 'ask' as const,
    onCloseActionChange: () => {},
  }

  it('macOS:「缩小到 Dock」', () => {
    withPlatform('darwin', () => {
      render(<NotificationsPane {...props} />)
      expect(screen.getByText('缩小到 Dock')).toBeInTheDocument()
    })
  })

  it('Windows:「最小化到托盘」', () => {
    withPlatform('win32', () => {
      const { container } = render(<NotificationsPane {...props} />)
      expect(screen.getByText('最小化到托盘')).toBeInTheDocument()
      expect(container.textContent).not.toMatch(/缩小到 Dock/)
    })
  })
})
