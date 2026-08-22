import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Titlebar } from './Titlebar'

const base = {
  collapsed: false, onToggleSidebar: () => {}, onView: () => {}, crumb: 'ws-a',
  notifs: [], updateAvailable: false, notifOpen: false, onToggleNotif: () => {},
  onOpenUpgrade: () => {}, onMarkAllRead: () => {}, onClearAllNotif: () => {},
}

describe('Titlebar – edit workspace button', () => {
  it('shows the edit button only in ws view when editable', () => {
    const { rerender } = render(<Titlebar {...base} view="home" canEditWorkspace onEditWorkspace={() => {}} />)
    expect(screen.queryByTitle(/编辑工作区/)).toBeNull()
    rerender(<Titlebar {...base} view="ws" canEditWorkspace onEditWorkspace={() => {}} />)
    expect(screen.getByTitle(/编辑工作区/)).toBeInTheDocument()
  })

  it('does not show the edit button in ws view when not editable', () => {
    render(<Titlebar {...base} view="ws" canEditWorkspace={false} onEditWorkspace={() => {}} />)
    expect(screen.queryByTitle(/编辑工作区/)).toBeNull()
  })

  it('calls onEditWorkspace when clicked', () => {
    const onEditWorkspace = vi.fn()
    render(<Titlebar {...base} view="ws" canEditWorkspace onEditWorkspace={onEditWorkspace} />)
    fireEvent.click(screen.getByTitle(/编辑工作区/))
    expect(onEditWorkspace).toHaveBeenCalledTimes(1)
  })
})

// ── Window controls ────────────────────────────────────────────────────────────────────────────
// The window is frameless on every platform, so we draw the controls ourselves. Where they sit and
// what they look like is not cosmetic: macOS puts them top-LEFT as coloured dots, Windows top-RIGHT
// as square glyphs. Drawing macOS' dots on Windows reads as a broken app.
function withPlatform(platform: string, fn: () => void) {
  const prev = (window as any).forge
  ;(window as any).forge = { ...(prev ?? {}), platform }
  try { fn() } finally { (window as any).forge = prev }
}

describe('Titlebar – window controls', () => {
  it('macOS: traffic-light dots, at the very start of the titlebar', () => {
    withPlatform('darwin', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const bar = container.querySelector('.titlebar')!
      expect(bar.querySelector('.traffic')).not.toBeNull()
      expect(bar.querySelector('.win-controls')).toBeNull()
      expect(bar.firstElementChild).toHaveClass('traffic')
    })
  })

  it('Windows: square controls, at the very end of the titlebar', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const bar = container.querySelector('.titlebar')!
      expect(bar.querySelector('.traffic')).toBeNull()
      expect(bar.querySelector('.win-controls')).not.toBeNull()
      expect(bar.lastElementChild).toHaveClass('win-controls')
    })
  })

  it('Windows: minimise / maximise / close in that left-to-right order', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const labels = [...container.querySelectorAll('.win-controls button')].map(b => b.getAttribute('aria-label'))
      expect(labels).toEqual(['最小化', '最大化', '关闭'])
    })
  })

  it('Windows: each control drives the matching window action', () => {
    const windowMinimize = vi.fn(), windowToggleMaximize = vi.fn(), windowClose = vi.fn()
    const prev = (window as any).forge
    ;(window as any).forge = { platform: 'win32', windowMinimize, windowToggleMaximize, windowClose }
    try {
      render(<Titlebar {...base} view="ws" />)
      fireEvent.click(screen.getByLabelText('最小化'))
      fireEvent.click(screen.getByLabelText('最大化'))
      fireEvent.click(screen.getByLabelText('关闭'))
      expect(windowMinimize).toHaveBeenCalledTimes(1)
      expect(windowToggleMaximize).toHaveBeenCalledTimes(1)
      expect(windowClose).toHaveBeenCalledTimes(1)
    } finally { (window as any).forge = prev }
  })

  it('macOS dots drive the same window actions', () => {
    const windowMinimize = vi.fn(), windowToggleMaximize = vi.fn(), windowClose = vi.fn()
    const prev = (window as any).forge
    ;(window as any).forge = { platform: 'darwin', windowMinimize, windowToggleMaximize, windowClose }
    try {
      render(<Titlebar {...base} view="ws" />)
      fireEvent.click(screen.getByLabelText('关闭'))
      fireEvent.click(screen.getByLabelText('最小化'))
      fireEvent.click(screen.getByLabelText('最大化'))
      expect(windowClose).toHaveBeenCalledTimes(1)
      expect(windowMinimize).toHaveBeenCalledTimes(1)
      expect(windowToggleMaximize).toHaveBeenCalledTimes(1)
    } finally { (window as any).forge = prev }
  })

  it('falls back to the macOS layout when the platform is unknown (tests, preload not injected)', () => {
    const prev = (window as any).forge
    ;(window as any).forge = undefined
    try {
      const { container } = render(<Titlebar {...base} view="ws" />)
      expect(container.querySelector('.traffic')).not.toBeNull()
    } finally { (window as any).forge = prev }
  })

  it('Windows: the maximise control reflects the restored/maximised state', () => {
    withPlatform('win32', () => {
      const { rerender, container } = render(<Titlebar {...base} view="ws" maximized={false} />)
      expect(container.querySelector('.win-controls button[aria-label="最大化"]')).not.toBeNull()
      rerender(<Titlebar {...base} view="ws" maximized />)
      expect(container.querySelector('.win-controls button[aria-label="向下还原"]')).not.toBeNull()
    })
  })
})

// ── 导航分组的位置 ──────────────────────────────────────────────────────────────────────────────
// mac 把左上角让给了红绿灯,所以所有东西都往右排。Windows 释放了左上角,如果布局照抄 mac,就会
// 左边空一块、右边 5 组控件加 3 个系统键挤成一团(齿轮紧挨最小化键,很容易点错)。
// 所以 Windows 上「首页/工作区」跟着面包屑走 —— 它们都是在回答"我在哪",本来就是一类。
describe('Titlebar – 导航分组在哪一侧', () => {
  const order = (container: HTMLElement) => {
    const bar = container.querySelector('.titlebar')!
    return [...bar.children].map(el => el.className.split(' ')[0])
  }

  it('macOS:导航在弹簧【之后】(靠右,和动作按钮一起)', () => {
    withPlatform('darwin', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const o = order(container)
      expect(o.indexOf('tb-seg')).toBeGreaterThan(o.indexOf('tb-spacer'))
    })
  })

  it('★ Windows:导航在弹簧【之前】(靠左,紧跟面包屑)', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const o = order(container)
      expect(o.indexOf('tb-seg')).toBeGreaterThan(-1)
      expect(o.indexOf('tb-seg')).toBeLessThan(o.indexOf('tb-spacer'))
      // 且紧跟在标题之后,中间不夹别的
      expect(o.indexOf('tb-seg')).toBe(o.indexOf('tb-title') + 1)
    })
  })

  it('★ Windows:设置是最左边第一个', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const first = container.querySelector('.titlebar')!.firstElementChild!
      expect(first.getAttribute('aria-label')).toBe('设置')
    })
  })

  // 折叠按钮要贴住它控制的那一侧,否则「点了半天不知道折的是哪个面板」。
  it('★ Windows:侧栏折叠贴左(仅次于设置)、面板折叠贴右(系统键前最后一个)', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const kids = [...container.querySelector('.titlebar')!.children]
      expect(kids[1].getAttribute('title')).toBe('折叠侧栏')
      expect(kids[kids.length - 2].getAttribute('title')).toBe('折叠面板')
      expect(kids[kids.length - 1].className).toContain('win-controls')
    })
  })

  it('macOS 顺序不变:红绿灯最左,设置最右', () => {
    withPlatform('darwin', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const kids = [...container.querySelector('.titlebar')!.children]
      expect(kids[0].className).toContain('traffic')
      expect(kids[kids.length - 1].getAttribute('aria-label')).toBe('设置')
    })
  })

  it('两个平台都只渲染一份导航,不会重复', () => {
    for (const p of ['darwin', 'win32']) {
      withPlatform(p, () => {
        const { container } = render(<Titlebar {...base} view="ws" />)
        expect(container.querySelectorAll('.tb-seg')).toHaveLength(1)
      })
    }
  })

  it('Windows:系统三键仍在最末尾,动作按钮不会跑到它后面', () => {
    withPlatform('win32', () => {
      const { container } = render(<Titlebar {...base} view="ws" />)
      const o = order(container)
      expect(o[o.length - 1]).toBe('win-controls')
    })
  })
})
