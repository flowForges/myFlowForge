import { describe, it, expect } from 'vitest'
import { nextInputMode, PANEL_H } from './inputPanel'

describe('输入区三态机', () => {
  it('点输入框 → 键盘', () => {
    expect(nextInputMode('idle', 'tapField')).toBe('keyboard')
    expect(nextInputMode('panel', 'tapField')).toBe('keyboard')
  })

  it('点 ＋ → 面板(微信:面板顶掉键盘,占它的位置)', () => {
    expect(nextInputMode('idle', 'tapPlus')).toBe('panel')
    expect(nextInputMode('keyboard', 'tapPlus')).toBe('panel')
  })

  it('面板开着再点 ＋ → 回到键盘(＋ 是个开关,不是单程票)', () => {
    expect(nextInputMode('panel', 'tapPlus')).toBe('keyboard')
  })

  it('★★收键盘这件事**不准**把面板一起关掉', () => {
    // 这是这个状态机存在的全部理由。打开面板的实现必然是「先 Keyboard.dismiss() 再显示面板」,
    // 而 dismiss 会立刻触发一次 keyboardHidden。要是那个事件把 mode 打回 idle,
    // 面板就在同一帧里被自己关掉了 —— 现象是「点 ＋ 没反应」,而且**看代码完全看不出来**。
    expect(nextInputMode('panel', 'keyboardHidden')).toBe('panel')
  })

  it('键盘自己被收起来(点了正文空白、按了系统收起)→ 什么都不开着', () => {
    expect(nextInputMode('keyboard', 'keyboardHidden')).toBe('idle')
    expect(nextInputMode('idle', 'keyboardHidden')).toBe('idle')
  })

  it('★键盘弹出来的时候面板必须让位 —— 两个一起显示会把输入框顶出屏幕', () => {
    expect(nextInputMode('panel', 'keyboardShown')).toBe('keyboard')
    expect(nextInputMode('idle', 'keyboardShown')).toBe('keyboard')
  })

  it('发出去之后保持原样 —— 连着发几条不该每条都要重新点开键盘', () => {
    expect(nextInputMode('keyboard', 'send')).toBe('keyboard')
    expect(nextInputMode('panel', 'send')).toBe('panel')
  })

  it('★离开这一屏一律清零', () => {
    expect(nextInputMode('panel', 'leave')).toBe('idle')
    expect(nextInputMode('keyboard', 'leave')).toBe('idle')
  })

  it('面板高度接近一块键盘 —— 太矮会在收键盘时露出一截正文再被盖住,画面抖一下', () => {
    expect(PANEL_H).toBeGreaterThan(220)
    expect(PANEL_H).toBeLessThan(320)
  })
})
