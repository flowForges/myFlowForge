import { describe, it, expect } from 'vitest'
import { TREE, elbowWidth, indentFor, trunkAt } from './tree'

/**
 * ★这里的期望值**一律写死字面量**,不拿 `TREE.*` 反推。
 *  拿常量算期望的断言会跟着常量一起变异 —— 把 `col` 改成 40 两边同时变,测试照样绿,
 *  而屏幕上早就错位了。本仓库这周已经被这种假绿骗过三次。
 */
describe('抽屉里那棵树的几何', () => {
  it('几个数就是这几个数(改了这里就是改了视觉,必须是有意的)', () => {
    expect(TREE.col).toBe(22)
    expect(TREE.trunk).toBe(7)
    expect(TREE.line).toBe(1)
    expect(TREE.gap).toBe(4)
    expect(TREE.rowGap).toBe(8)
  })

  it('横杠从主干画到卡片前的气口', () => {
    expect(elbowWidth()).toBe(10)
    expect(elbowWidth({ col: 30, trunk: 5, line: 1, gap: 2, rowGap: 8 })).toBe(22)
  })

  it('★连接列窄到放不下时退成 0,不给 RN 一个负宽度', () => {
    expect(elbowWidth({ col: 8, trunk: 7, line: 1, gap: 4, rowGap: 8 })).toBe(0)
  })

  it('★横杠 + 主干 + 气口正好填满连接列 —— 差一点就是「横杠没够到卡片」', () => {
    // 7(主干 x)+ 1(线宽)+ 10(横杠)+ 4(气口)= 22(列宽)。全是字面量,不从 TREE 反推。
    expect(7 + 1 + 10 + 4).toBe(22)
    expect(TREE.trunk + TREE.line + elbowWidth() + TREE.gap).toBe(22)
  })

  it('★只有最后一条会话收住主干,中间的都穿过去', () => {
    expect(trunkAt(0, 1)).toBe('stop')
    expect(trunkAt(0, 3)).toBe('through')
    expect(trunkAt(1, 3)).toBe('through')
    expect(trunkAt(2, 3)).toBe('stop')
  })

  it('★下标越界也收住 —— 主干绝不许从最后一张卡底下继续往下伸', () => {
    expect(trunkAt(5, 3)).toBe('stop')
  })

  it('会话行不缩进(连接列自己顶着),不上树的那几样缩到卡片左沿', () => {
    expect(indentFor('session')).toBe(0)
    expect(indentFor('aside')).toBe(22)
  })
})
