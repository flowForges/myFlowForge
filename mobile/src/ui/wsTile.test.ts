import { describe, it, expect } from 'vitest'
import { tileLabel, tileHue, tileColor } from './wsTile'

// 用户那台机器上真实的 10 个工作区 —— 这条规则就是拿它们渲染出来才定的。
const REAL = [
  'for-test-0823', 'ff-website', 'for-new-0809', 'blog_system', 'for-new-0731',
  'for-new-0730', 'for-new-flow', 'example', 'for-new-0731v2', 'workspace',
]

describe('tileLabel', () => {
  it('★末段带数字取后 4 位 —— 区分度在末尾,不在开头', () => {
    expect(tileLabel('for-test-0823')).toBe('0823')
    expect(tileLabel('for-new-0809')).toBe('0809')
    expect(tileLabel('for-new-0730')).toBe('0730')
  })

  it('★★0731 和 0731v2 必须分得开 —— 取**前** 4 位的话两个都是 0731', () => {
    expect(tileLabel('for-new-0731')).toBe('0731')
    expect(tileLabel('for-new-0731v2')).toBe('31v2')
    expect(tileLabel('for-new-0731')).not.toBe(tileLabel('for-new-0731v2'))
  })

  it('纯词取前 2 个字母大写', () => {
    expect(tileLabel('for-new-flow')).toBe('FL')
    expect(tileLabel('ff-website')).toBe('WE')
    expect(tileLabel('blog_system')).toBe('SY')
  })

  it('下划线和连字符都算分段', () => {
    expect(tileLabel('blog_system')).toBe('SY')
    expect(tileLabel('a-b_c-done')).toBe('DO')
  })

  it('没有分隔符时就拿整个名字当末段', () => {
    expect(tileLabel('example')).toBe('EX')
    expect(tileLabel('workspace')).toBe('WO')
  })

  it('★真实那 10 个区的字必须两两不同 —— 首字母方案在这条上会红(6 个都是 F)', () => {
    const labels = REAL.map(tileLabel)
    expect(new Set(labels).size).toBe(REAL.length)
  })

  it('空名字 / 纯分隔符不炸,给一个占位', () => {
    expect(tileLabel('')).toBe('·')
    expect(tileLabel('---')).toBe('·')
  })

  it('★永远不超过 4 个字符 —— 34px 的方块放不下更多', () => {
    for (const n of [...REAL, 'a-verylongtrailingsegment', 'x-1234567890']) {
      expect(tileLabel(n).length).toBeLessThanOrEqual(4)
    }
  })
})

describe('tileHue', () => {
  it('同一个名字永远同一个色相(换个皮肤、重开 app 都不该变色)', () => {
    expect(tileHue('for-new-0731')).toBe(tileHue('for-new-0731'))
  })

  it('★按**全名**散列,不是按色块上那几个字 —— 字撞了的时候颜色是唯一还能分开它们的东西', () => {
    // ★这两个的 label **完全一样**(都是 `0731`),全名不同。按 label 散列的话它们会同色,
    //  而那正好是色块最需要帮上忙的场景。
    //  ★第一版这条挑的是 for-new-0731 / for-new-0730 —— 它俩的 label 本来就不同(0731/0730),
    //   所以按 label 散列照样能分开,变异测试直接跑绿。这条断言当时是**假的**。
    expect(tileLabel('for-new-0731')).toBe(tileLabel('proj-0731'))
    expect(tileHue('for-new-0731')).not.toBe(tileHue('proj-0731'))
  })

  it('色相落在 0-359', () => {
    for (const n of REAL) {
      const h = tileHue(n)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(360)
    }
  })

  it('★tileColor 给的是 RN 认识的 hsl() —— RN 不支持原型里那套 oklch()', () => {
    expect(tileColor('for-new-0731')).toMatch(/^hsl\(\d{1,3}, 42%, 44%\)$/)
  })
})
