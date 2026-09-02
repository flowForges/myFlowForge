import { describe, it, expect } from 'vitest'
import qrcode from 'qrcode-generator'
import { qrTerminalLines, canDrawQr } from './qrTerminal'

const ESC = '\u001b'
/** 去掉所有 ANSI 转义,只留字符格 —— 断言几何时不该被颜色干扰。 */
const plain = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')

const LINK = 'myflowforge://add-host?v=1&a=127.0.0.1:6767'

describe('终端二维码', () => {
  it('每行等宽,而且一行画两排模块', () => {
    const lines = qrTerminalLines(LINK)
    const widths = new Set(lines.map((l) => [...plain(l)].length))
    expect(widths.size).toBe(1)
    const w = [...widths][0]!
    expect(lines.length).toBe(Math.ceil(w / 2))
    expect(w).toBeGreaterThan(8)
  })

  it('★静区是浅的 —— 第一行里不能有任何深块', () => {
    // 前两排模块整个落在四格静区里。这一行出现深色 = 静区被吃掉了,很多相机就认不出来。
    const lines = qrTerminalLines(LINK)
    expect(lines[0]).not.toContain(`${ESC}[30m`)
    expect(lines[0]).not.toContain(`${ESC}[40m`)
    // 最后一行的下半排要么是静区、要么在码外 —— 两种都必须是浅底
    expect(lines[lines.length - 1]).not.toContain(`${ESC}[40m`)
  })

  it('★深浅两种块都用**显式**颜色画,不靠终端默认前景色', () => {
    const all = qrTerminalLines('myflowforge://add-host?v=1&a=10.0.0.2:6767&t=abc').join('\n')
    expect(all).toContain(`${ESC}[30m`)   // 深块前景
    expect(all).toContain(`${ESC}[47m`)   // 浅块背景
    expect(all.endsWith(`${ESC}[0m`)).toBe(true)
  })

  it('★一枚真配对码(带 44 字符公钥 + 令牌)也画得下 —— 不超过 80 列', () => {
    // ssh 窗口默认 80 列,折行的码作废。这条钉的是"真实长度"而不是一个短样例。
    const link =
      'myflowforge://add-host?v=1&a=192.168.1.20%3A6767&t=' + 'a'.repeat(43) +
      '&n=server&k=' + encodeURIComponent('A'.repeat(43) + '=')
    const lines = qrTerminalLines(link)
    expect([...plain(lines[0]!)].length).toBeLessThanOrEqual(80)
  })

  it('★★把画出来的东西**读回矩阵**,和 qrcode-generator 说的一模一样', () => {
    // 这是唯一能在没有相机的情况下证明「码是对的」的办法:几何(哪一格对应哪个模块)、
    // 静区、以及深浅有没有画反 —— 三件事一起钉住。画反的码有些扫码器认、有些不认,
    // 那种偶发失败没人会往「终端配色」上想。
    const link = 'myflowforge://add-host?v=1&a=10.0.0.5:6767&t=abcdef'
    const qr = qrcode(0, 'M')
    qr.addData(link)
    qr.make()
    const n = qr.getModuleCount()
    const QUIET = 4

    // 一行 = 上下两排模块:前景色说上面那排,背景色说下面那排。
    const grid: boolean[][] = []
    for (const line of qrTerminalLines(link)) {
      const top: boolean[] = []
      const bottom: boolean[] = []
      let fgDark = false
      let bgDark = false
      for (const tok of line.split('▀')) {
        // tok 是这一格前面的样式串(可能为空 = 沿用上一格)
        if (tok.includes(`${ESC}[30m`)) fgDark = true
        if (tok.includes(`${ESC}[37m`)) fgDark = false
        if (tok.includes(`${ESC}[40m`)) bgDark = true
        if (tok.includes(`${ESC}[47m`)) bgDark = false
        if (tok.includes(`${ESC}[0m`)) break      // 行尾的 reset,后面没有格子了
        top.push(fgDark)
        bottom.push(bgDark)
      }
      grid.push(top, bottom)
    }

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        expect(grid[r + QUIET]![c + QUIET], `模块 ${r},${c}`).toBe(qr.isDark(r, c))
      }
    }
    // 静区四边全浅
    for (let c = 0; c < n + QUIET * 2; c++) {
      expect(grid[0]![c], `上静区 ${c}`).toBe(false)
      expect(grid[n + QUIET * 2 - 1]![c], `下静区 ${c}`).toBe(false)
    }
    for (let r = 0; r < n + QUIET * 2; r++) {
      expect(grid[r]![0], `左静区 ${r}`).toBe(false)
      expect(grid[r]![n + QUIET * 2 - 1], `右静区 ${r}`).toBe(false)
    }
  })

  it('没有 TTY 就不画', () => {
    expect(canDrawQr({ isTTY: true })).toBe(true)
    expect(canDrawQr({})).toBe(false)
  })
})
