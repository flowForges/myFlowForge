import { describe, it, expect } from 'vitest'
import { TREE, elbowWidth, indentFor, trunkAt } from './tree'

/**
 * ★这里的期望值**一律写死字面量**,不拿 `TREE.*` 反推。
 *  拿常量算期望的断言会跟着常量一起变异 —— 把 `col` 改成 40 两边同时变,测试照样绿,
 *  而屏幕上早就错位了。本仓库这周已经被这种假绿骗过三次。
 */
describe('抽屉里那棵树的几何', () => {
  it('几个数就是这几个数(改了这里就是改了视觉,必须是有意的)', () => {
    // ★全出血之后的二级缩进:内容左沿 44(iOS 标准),主干 26。
    //  旧值 col 22 / trunk 7 属于「抽屉有 12pt 外边距 + List 有 10pt 内边距」的卡片时代 ——
    //  10 + 7 = 17 正好等于电脑端侧栏那条线。边距没了,主干得自己站到 44 这一档里。
    // ★rowGap 已删除:全出血的行齐平,连接列首尾相接,主干天然连续。
    expect(TREE.col).toBe(44)
    expect(TREE.trunk).toBe(26)
    expect(TREE.line).toBe(1)
    expect(TREE.gap).toBe(4)
    expect('rowGap' in TREE).toBe(false)
  })

  it('横杠从主干画到卡片前的气口', () => {
    expect(elbowWidth()).toBe(13)
    expect(elbowWidth({ col: 30, trunk: 5, line: 1, gap: 2 })).toBe(22)
  })

  it('★连接列窄到放不下时退成 0,不给 RN 一个负宽度', () => {
    expect(elbowWidth({ col: 8, trunk: 7, line: 1, gap: 4 })).toBe(0)
  })

  it('★横杠 + 主干 + 气口正好填满连接列 —— 差一点就是「横杠没够到卡片」', () => {
    // 26(主干 x)+ 1(线宽)+ 13(横杠)+ 4(气口)= 44(列宽)。全是字面量,不从 TREE 反推。
    expect(26 + 1 + 13 + 4).toBe(44)
    expect(TREE.trunk + TREE.line + elbowWidth() + TREE.gap).toBe(44)
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
    expect(indentFor('aside')).toBe(44)
  })
})
