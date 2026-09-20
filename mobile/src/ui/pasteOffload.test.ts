import { describe, it, expect } from 'vitest'
import { textAfterOffload } from './pasteOffload'

const N = 'pasted-20260826-090507.txt'
// 「粘进来的那一大坨」。内容本身不重要,重要的是它在正文里占了多长一段。
const RAW = '报错堆栈'.repeat(10)

describe('textAfterOffload —— 存盘那几百毫秒里人还在打字', () => {
  it('正文一个字没动:整段被占位符替掉', () => {
    expect(textAfterOffload(RAW, RAW, N)).toBe(`[${N}]`)
  })

  it('人在这一坨【后面】接着打字:占位符仍然落在原位,他打的字原样留着', () => {
    const latest = RAW + '哪里错了？'
    // 前缀还对得上 → 原位替换 0..RAW.length;后面紧挨着文字,所以补一个空格。
    expect(textAfterOffload(latest, RAW, N)).toBe(`[${N}] 哪里错了？`)
  })

  it('★人在这一坨【前面】插了字:占位符退到末尾,他插的字和原文一个都不丢', () => {
    const latest = '先看这个' + RAW
    // 下标已经指向别处了,硬按 0..RAW.length 替换会把他插的四个字连同一截原文一起吃掉。
    expect(textAfterOffload(latest, RAW, N)).toBe(`${latest} [${N}]`)
    // 说清「不丢字」是什么意思:他打的每一个字都还在结果里。
    expect(textAfterOffload(latest, RAW, N).startsWith('先看这个')).toBe(true)
    expect(textAfterOffload(latest, RAW, N).includes(RAW)).toBe(true)
  })

  it('人在等待期间把输入框清空了:只剩一个占位符,不越界也不报错', () => {
    expect(textAfterOffload('', RAW, N)).toBe(`[${N}]`)
  })

  it('空正文(理论上按不到这个入口,但不许炸)', () => {
    expect(textAfterOffload('', '', N)).toBe(`[${N}]`)
  })

  it('人在等待期间把这一坨改了一部分:退到末尾,改过的内容原样保留', () => {
    const latest = RAW.slice(0, 8) + '(我手改的)' + RAW.slice(8)
    expect(textAfterOffload(latest, RAW, N)).toBe(`${latest} [${N}]`)
  })
})
