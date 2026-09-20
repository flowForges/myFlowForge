import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { SF, EMOJI, MATERIAL, ICON_NAMES } from './icons'

describe('图标三张映射表', () => {
  it('★键集必须完全一致 —— 漏一边就是那个平台上一个空白格', () => {
    expect(Object.keys(SF).sort()).toEqual(Object.keys(EMOJI).sort())
    expect(Object.keys(SF).sort()).toEqual(Object.keys(MATERIAL).sort())
  })

  it('ICON_NAMES 就是那份键集,没有第四份真相', () => {
    expect([...ICON_NAMES].sort()).toEqual(Object.keys(SF).sort())
  })

  it('没有空值 —— 空字符串渲染成一个看不见的洞', () => {
    for (const k of ICON_NAMES) {
      expect(SF[k], `SF.${k}`).toBeTruthy()
      expect(EMOJI[k], `EMOJI.${k}`).toBeTruthy()
      expect(MATERIAL[k], `MATERIAL.${k}`).toBeTruthy()
    }
  })

  it('SF 符号名不许带空格 —— 那是拼错了(SF Symbols 一律用点分)', () => {
    for (const k of ICON_NAMES) expect(SF[k]).not.toMatch(/\s/)
  })

  it('★★每一个 Material 名字都要在**真正的** glyphmap 里 —— 写错不报错,只渲染成一个洞', () => {
    // ★读的是 `@expo/vector-icons` 自己那份 glyphmap,不是我抄一份进来的名单。
    //  抄一份的话,升级图标库删掉某个名字时这条测试照样绿,而真机上那一格变空。
    const require_ = createRequire(import.meta.url)
    const glyphs = require_(
      '@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialIcons.json',
    ) as Record<string, number>
    // 先确认 glyphmap 自己是真的(路径写错时 require 会抛,但空对象会让下面全部通过)
    expect(Object.keys(glyphs).length).toBeGreaterThan(500)
    for (const k of ICON_NAMES) {
      expect(glyphs, `MATERIAL.${k} = "${MATERIAL[k]}" 不在 MaterialIcons 里`).toHaveProperty(MATERIAL[k])
    }
  })

  it('Material 名字用连字符,不用点或下划线(写成 SF / 字体常量的形状是最常见的手滑)', () => {
    for (const k of ICON_NAMES) expect(MATERIAL[k], `MATERIAL.${k}`).toMatch(/^[a-z0-9-]+$/)
  })
})
