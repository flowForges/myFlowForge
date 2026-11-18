import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CU_RESOLVE_ERR } from '@shared/computerUse'
import { CuGateCard } from './CuGateCard'
import type { CuGate } from '../../../main/computerUse/types'

const key = { workspacePath: '/ws', sessionId: 's1' }
const mk = (over: Partial<CuGate>): CuGate => ({ id: 'g1', key, kind: 'action', ts: 1, ...over })
const row = (container: HTMLElement, name: string) => {
  const r = Array.from(container.querySelectorAll('.cu-row')).find((el) => el.querySelector('.cu-k')?.textContent === name)
  if (!r) throw new Error('no row ' + name)
  return r as HTMLElement
}

describe('CuGateCard', () => {
  it('click: trusted rows (app with bundle id, position, button/count/mods) above a bordered crop row named 屏幕', () => {
    const { container } = render(<CuGateCard gate={mk({
      action: { kind: 'click', app: 'Safari', bundleId: 'com.apple.Safari', at: { x: 812, y: 433 }, button: 'left', count: 2, mods: ['cmd'] },
      crop: 'QUJD', reason: '始终询问',
    })} />)
    expect(screen.getByText('电脑 · 点击')).toBeTruthy()
    expect(row(container, '应用').textContent).toContain('Safari · com.apple.Safari')
    expect(row(container, '位置').textContent).toContain('(812, 433)')
    expect(row(container, '按键').textContent).toContain('左键 ×2 · ⌘')
    expect(container.querySelector('.cu-chip.cu-reason')?.textContent).toBe('始终询问')
    const crop = row(container, '屏幕')
    const img = crop.querySelector('img') as HTMLImageElement
    expect(img.src).toBe('data:image/jpeg;base64,QUJD')
    expect(crop.querySelector('.cu-crop')).toBeTruthy()
    // trusted rows come first, the crop row last
    const rows = Array.from(container.querySelectorAll('.cu-row'))
    expect(rows[rows.length - 1]).toBe(crop)
  })

  it('type: marked text block with ⏎ ⇥ ␛ and the N 字 chip', () => {
    const text = 'a\nb\tc\u001bd'
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'type', app: 'Notes', bundleId: 'com.apple.Notes', text: 'hello world!' } })} />)
    expect(screen.getByText('电脑 · 输入')).toBeTruthy()
    expect(screen.getByText('12 字')).toBeTruthy()
    render(<CuGateCard gate={mk({ id: 'g2', action: { kind: 'type', text } })} />)
    const blocks = container.ownerDocument.querySelectorAll('.cu-text')
    expect(blocks[1].textContent).toBe('a⏎b⇥c␛d')
    expect(blocks[1].hasAttribute('data-untrusted')).toBe(true)
  })

  it('key: keycap chips; paste reason adds the 剪贴板: 粘贴 row', () => {
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'key', app: 'Notes', combo: '⌘⇧V', mods: ['cmd', 'shift'] }, reason: '剪贴板' })} />)
    const caps = Array.from(row(container, '按键').querySelectorAll('.cu-cap')).map((e) => e.textContent)
    expect(caps).toEqual(['⌘', '⇧', 'V'])
    expect(row(container, '剪贴板').textContent).toContain('粘贴')
    expect(container.querySelector('.cu-chip.cu-reason')?.textContent).toBe('剪贴板')
  })

  it('scroll and drag rows', () => {
    const a = render(<CuGateCard gate={mk({ action: { kind: 'scroll', app: 'Finder', at: { x: 1, y: 2 }, dy: 3, dx: 0 } })} />)
    expect(row(a.container, '滚动').textContent).toContain('↓3 →0')
    const b = render(<CuGateCard gate={mk({ id: 'g3', action: { kind: 'drag', app: 'Finder', toApp: 'Notes', at: { x: 1, y: 2 }, to: { x: 5, y: 6 } } })} />)
    expect(row(b.container, '从').textContent).toContain('Finder')
    expect(row(b.container, '到').textContent).toContain('Notes')
  })

  it('screen-derived names are plain text: whitespace collapsed, long values cut from the left, markup not parsed', () => {
    const name = '  x'.repeat(5) + '<b>evil</b>' + 'z'.repeat(80) + 'TAIL'
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'click', app: name, at: { x: 1, y: 1 } } })} />)
    const v = row(container, '应用').textContent!
    expect(v.startsWith('应用')).toBe(true)
    expect(v.endsWith('TAIL')).toBe(true)
    expect(v).toContain('…')
    expect(container.querySelector('b')).toBeNull()
  })

  it('shows the refusal code from main as a chip on the card', () => {
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} error="not_pending" />)
    expect(container.querySelector('.cu-chip.cu-code')?.textContent).toBe(CU_RESOLVE_ERR.not_pending)   // M-14: never the raw code
  })

  it('the 应用 row has the bundle id in its own span; a drag shows the target bundle id too', () => {
    const a = render(<CuGateCard gate={mk({ action: { kind: 'click', app: 'Safari', bundleId: 'com.apple.Safari', at: { x: 1, y: 1 } } })} />)
    expect(row(a.container, '应用').querySelector('.cu-bundle')?.textContent).toBe('com.apple.Safari')
    const b = render(<CuGateCard gate={mk({ id: 'g9', action: { kind: 'drag', app: 'Finder', bundleId: 'com.apple.finder', toApp: 'Notes', toBundle: 'com.apple.Notes', at: { x: 1, y: 2 }, to: { x: 5, y: 6 } } })} />)
    expect(row(b.container, '到').querySelector('.cu-bundle')?.textContent).toBe('com.apple.Notes')
    expect(row(b.container, '从').querySelector('.cu-bundle')?.textContent).toBe('com.apple.finder')
  })

  it('act: 应用 / 控件 / 动作 rows (spec §10)', () => {
    const { container } = render(<CuGateCard gate={mk({
      action: {
        kind: 'act', app: { name: 'WorkBuddy', bundleId: 'com.example.workbuddy' }, bundleId: 'com.example.workbuddy',
        element: { role: 'button', name: '新建会话' }, actLabel: '点击',
      },
    })} />)
    expect(row(container, '应用').textContent).toContain('WorkBuddy · com.example.workbuddy')
    expect(row(container, '控件').textContent).toContain('按钮「新建会话」')
    expect(row(container, '动作').textContent).toContain('点击')
  })

  it('act type: adds a 文字 block and the N 字 chip', () => {
    const { container } = render(<CuGateCard gate={mk({
      action: { kind: 'act', app: { name: 'WorkBuddy', bundleId: 'x' }, element: { role: 'textfield', name: '输入消息' }, actLabel: '输入', text: '你好' },
    })} />)
    expect(container.querySelector('.cu-text')?.textContent).toBe('你好')
    expect(container.querySelector('.cu-chip.cu-count')?.textContent).toBe('2 字')
  })

  it('act flags: physical → 方式: 移动鼠标点击; replace → 方式: 替换原有内容; scroll → 滚动: 箭头 ×amount', () => {
    const a = render(<CuGateCard gate={mk({ action: { kind: 'act', element: { role: 'button' }, actLabel: '点击', physical: true } })} />)
    expect(row(a.container, '方式').textContent).toContain('移动鼠标点击')
    const b = render(<CuGateCard gate={mk({ id: 'g2', action: { kind: 'act', element: { role: 'textfield' }, actLabel: '设置', replace: true } })} />)
    expect(row(b.container, '方式').textContent).toContain('替换原有内容')
    const c = render(<CuGateCard gate={mk({ id: 'g3', action: { kind: 'act', element: { role: 'list' }, actLabel: '滚动', direction: 'down', amount: 3 } })} />)
    expect(row(c.container, '滚动').textContent).toContain('↓ ×3')
  })

  it('launch: 动作: 打开应用 row, plus the 应用 row', () => {
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'launch', app: { name: 'Terminal', bundleId: 'com.apple.Terminal' } } })} />)
    expect(row(container, '动作').textContent).toContain('打开应用')
    expect(row(container, '应用').textContent).toContain('Terminal')
  })

  it('appKey: keycap chips (reusing the key row) and the 应用 row', () => {
    const { container } = render(<CuGateCard gate={mk({
      action: { kind: 'appKey', app: { name: 'Notes', bundleId: 'com.apple.Notes' }, combo: '⌘⇧V', mods: ['cmd', 'shift'] },
    })} />)
    const caps = Array.from(row(container, '按键').querySelectorAll('.cu-cap')).map((e) => e.textContent)
    expect(caps).toEqual(['⌘', '⇧', 'V'])
    expect(row(container, '应用').textContent).toContain('Notes')
  })

  it('continue gate: 原因 row shows the reason, title is 电脑 · 继续', () => {
    render(<CuGateCard gate={mk({ kind: 'continue', reason: '已执行 100 步' })} />)
    expect(screen.getByText('电脑 · 继续')).toBeTruthy()
    expect(screen.getByText('已执行 100 步')).toBeTruthy()
  })

  it('no explanatory text: no <p>, no <small>, no hint-like class', () => {
    const { container } = render(<CuGateCard gate={mk({ action: { kind: 'type', app: 'A', text: 'x' }, crop: 'QQ==', reason: '终端' })} />)
    expect(container.querySelector('p, small')).toBeNull()
    container.querySelectorAll('*').forEach((el) => expect(String(el.getAttribute('class') ?? '')).not.toMatch(/hint|desc|help|note|tip|caption/))
    expect(within(container).queryByText(/^(提示|说明)/)).toBeNull()
  })

  describe('spec §9.2: the main window never answers a gate — no buttons, just the chip 待批准', () => {
    it('an action gate: chip 待批准, no 允许 / 拒绝 / 停止 button anywhere on the card', () => {
      const { container } = render(<CuGateCard gate={mk({ action: { kind: 'click', at: { x: 1, y: 1 } } })} />)
      expect(container.querySelectorAll('button')).toHaveLength(0)
      expect(screen.getByText('待批准')).toBeTruthy()
      expect(container.querySelector('.cu-chip')?.textContent).toContain('待批准')
      expect(screen.queryByText('允许')).toBeNull()
      expect(screen.queryByText('拒绝')).toBeNull()
      expect(screen.queryByText('停止')).toBeNull()
    })

    it('a continue (已执行 100 步) gate: same chip, no 继续 100 步 / 停止 button', () => {
      const { container } = render(<CuGateCard gate={mk({ kind: 'continue', reason: '已执行 100 步' })} />)
      expect(container.querySelectorAll('button')).toHaveLength(0)
      expect(screen.getByText('待批准')).toBeTruthy()
      expect(screen.queryByText('继续 100 步')).toBeNull()
      expect(screen.queryByText('停止')).toBeNull()
    })
  })
})
