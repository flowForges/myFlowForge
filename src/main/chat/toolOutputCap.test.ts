import { describe, it, expect } from 'vitest'
import { capToolOutput, capToolOutputs, readCap } from './toolOutputCap'
import type { ChatMessage, ToolActivity } from '@shared/types'

/**
 * 这份测试守的是两件方向相反的事:
 *  ① 真的把字节砍下来(不然「打开长会话要十秒」原封不动);
 *  ② 砍完**说实话** —— `outputLines` 必须是原始行数,否则界面会理直气壮地说「共 200 行」。
 * ②比①重要:慢只是慢,骗人是让人以为自己看到了全部。
 */

const tool = (output: string, over: Partial<ToolActivity> = {}): ToolActivity =>
  ({ id: 't1', title: '调用 shell', status: 'ok', output, ...over })
const msg = (tools: ToolActivity[]): ChatMessage =>
  ({ id: 'm1', who: 'ai', text: '好了', ts: '2026-09-03T00:00:00Z', tools })

const CAP = { lines: 200, bytes: 16 * 1024 }

describe('工具输出截断', () => {
  it('没超上限的**原样返回同一个对象** —— 不白拷贝,引用相等也仍然成立', () => {
    const t = tool('一行\n两行\n三行')
    expect(capToolOutput(t, CAP)).toBe(t)
    // 没有工具的消息同理
    const m: ChatMessage = { id: 'm', who: 'ai', text: 'x', ts: 'now' }
    expect(capToolOutputs([m], CAP)[0]).toBe(m)
  })

  it('按行数截:只留上限那么多行,并带上**原始**行数', () => {
    const t = tool(Array.from({ length: 5291 }, (_, i) => `第 ${i} 行`).join('\n'))
    const c = capToolOutput(t, CAP)
    expect(c.output!.split('\n')).toHaveLength(200)
    expect(c.outputLines).toBe(5291)
    // 留的是**开头**那 200 行 —— 工具输出里最要紧的信息(命令、报错的第一行)都在前面
    expect(c.output!.startsWith('第 0 行\n第 1 行')).toBe(true)
  })

  it('★按字节截:挡的是「一行五万字」—— 只数行数的话那种一行就能把整份历史撑回去', () => {
    const t = tool('x'.repeat(50_000))          // 一行,五万字
    const c = capToolOutput(t, CAP)
    expect(Buffer.byteLength(c.output!, 'utf8')).toBeLessThanOrEqual(CAP.bytes)
    expect(c.outputLines).toBe(1)
  })

  it('★按字节切不许切出半个汉字 —— 屏幕上多一个「�」比少一行更像 bug', () => {
    // 每个汉字 3 字节,取一个和 bytes 除不尽的上限,保证切在字符中间
    const t = tool('中'.repeat(1000))
    const c = capToolOutput(t, { lines: 200, bytes: 1000 })
    expect(c.output).not.toContain('�')
    expect(Buffer.byteLength(c.output!, 'utf8')).toBeLessThanOrEqual(1000)
    // 切完仍然全是完整的汉字
    expect([...c.output!].every((ch) => ch === '中')).toBe(true)
  })

  it('★★不改原数据 —— 磁盘上那份的解析结果可能被别处共用,就地改会把别人的也截了', () => {
    const long = Array.from({ length: 400 }, (_, i) => `L${i}`).join('\n')
    const t = tool(long)
    const m = msg([t])
    const out = capToolOutputs([m], CAP)
    expect(t.output).toBe(long)               // 原对象一个字没动
    expect(t.outputLines).toBeUndefined()
    expect(out[0]).not.toBe(m)                // 截过的那条是新对象
    expect(out[0].tools![0].output!.split('\n')).toHaveLength(200)
  })

  it('一条消息里只截超标的那几个工具,没超的保持同一个引用', () => {
    const small = tool('短', { id: 'a' })
    const big = tool(Array.from({ length: 900 }, (_, i) => `L${i}`).join('\n'), { id: 'b' })
    const out = capToolOutputs([msg([small, big])], CAP)
    expect(out[0].tools![0]).toBe(small)
    expect(out[0].tools![1]).not.toBe(big)
  })

  it('没有 output 的工具(codex 的「编辑文件」就不给)原样放行', () => {
    const t: ToolActivity = { id: 't', title: '编辑文件', status: 'ok' }
    expect(capToolOutput(t, CAP)).toBe(t)
  })

  it('readCap:没给、给了脏值都当「不要截断」—— 老客户端行为逐字不变', () => {
    expect(readCap({})).toBeNull()
    expect(readCap({ toolOutputLines: 0 })).toBeNull()
    expect(readCap({ toolOutputLines: -5 })).toBeNull()
    expect(readCap({ toolOutputLines: NaN })).toBeNull()
    expect(readCap({ toolOutputLines: '200' as unknown as number })).toBeNull()
    expect(readCap({ toolOutputLines: 200 })).toEqual({ lines: 200, bytes: 64 * 1024 })
    expect(readCap({ toolOutputLines: 200, toolOutputBytes: 16384 })).toEqual({ lines: 200, bytes: 16384 })
  })
})

describe('★这么做到底省了多少 —— 照着真会话的形状量', () => {
  /**
   * 2026-09-03 剖了六个真会话文件,形状高度一致:**99% 的字节是 `tools[].output`**。
   * 最大那个 7 条消息 3.0 MB,其中 tools 3.0 MB、正文 37 KB;工具输出行数中位数 76,
   * 九成在 221 行以内,但有几个是几千行的日志 —— 就是那几个把整份历史撑起来的。
   *
   * ★这条断言钉的是**目的**,不是实现。哪天有人把上限调成 5000 行「以防万一」,
   *  它会当场红 —— 而那种改动在别的测试里一个字都看不出来。
   */
  it('长会话的历史至少小一个数量级', () => {
    const bigOutput = (n: number) => Array.from({ length: n }, (_, i) => `2026-09-03 12:00:00 [info] 第 ${i} 行日志输出`).join('\n')
    // 照实测的分布造:大多数几十行,少数几千行
    const tools: ToolActivity[] = [
      ...Array.from({ length: 80 }, (_, i) => tool(bigOutput(76), { id: `s${i}` })),
      ...Array.from({ length: 14 }, (_, i) => tool(bigOutput(3000), { id: `b${i}` })),
    ]
    const msgs = [msg(tools)]
    const before = JSON.stringify(msgs).length
    const after = JSON.stringify(capToolOutputs(msgs, CAP)).length
    expect(before / after).toBeGreaterThan(5)
    // 中位数那 80 个根本没被碰到 —— 截断只该动真正超标的那几个
    expect(capToolOutputs(msgs, CAP)[0].tools!.slice(0, 80).every((t, i) => t === tools[i])).toBe(true)
  })
})
