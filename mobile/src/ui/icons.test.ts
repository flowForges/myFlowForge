import { describe, it, expect } from 'vitest'
import { SF, EMOJI, ICON_NAMES } from './icons'

describe('图标两张映射表', () => {
  it('★键集必须完全一致 —— 漏一边就是安卓上一个空白格', () => {
    expect(Object.keys(SF).sort()).toEqual(Object.keys(EMOJI).sort())
  })

  it('ICON_NAMES 就是那份键集,没有第三份真相', () => {
    expect([...ICON_NAMES].sort()).toEqual(Object.keys(SF).sort())
  })

  it('没有空值 —— 空字符串在 iOS 上渲染成一个看不见的洞', () => {
    for (const k of ICON_NAMES) {
      expect(SF[k], `SF.${k}`).toBeTruthy()
      expect(EMOJI[k], `EMOJI.${k}`).toBeTruthy()
    }
  })

  it('SF 符号名不许带空格 —— 那是拼错了(SF Symbols 一律用点分)', () => {
    for (const k of ICON_NAMES) expect(SF[k]).not.toMatch(/\s/)
  })
})
