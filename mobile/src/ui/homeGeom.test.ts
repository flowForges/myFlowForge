import { describe, it, expect } from 'vitest'
import { HOME, separatorInset } from './homeGeom'
import { TREE } from './tree'

/** ★期望值一律写死字面量,不拿 HOME.* 反推 —— 拿常量算期望会跟着常量一起变异,永远绿。 */
describe('首页全出血的横向几何', () => {
  it('几个数就是这几个数(改了这里就是改了视觉,必须是有意的)', () => {
    expect(HOME.rowInsetX).toBe(16)
    expect(HOME.minRowH).toBe(58)
    expect(HOME.minDeepRowH).toBe(54)
  })

  it('★★分隔线按层级内缩 —— 缝隙的位置本身在说层级,这是 iOS 列表的核心语法', () => {
    expect(separatorInset('ws')).toBe(16)
    expect(separatorInset('session')).toBe(44)
  })

  it('★★跨文件约束:会话行分隔线的起点必须等于树的连接列宽度', () => {
    // 不相等 = 分隔线的起点和会话标题的左沿差一截。屏幕上就是「说不上哪儿不对」,
    // 而且布局在 node/jsdom 里量不了 —— 除了这一条断言,没有任何东西会告诉你。
    expect(separatorInset('session')).toBe(TREE.col)
  })

  it('一级行的内缩比二级浅 —— 反过来就等于说工作区从属于会话', () => {
    expect(separatorInset('ws')).toBeLessThan(separatorInset('session'))
  })
})
