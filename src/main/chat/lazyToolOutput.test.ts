import { describe, it, expect } from 'vitest'
import { capToolOutput, capToolOutputs, readCap } from './toolOutputCap'
import type { ChatMessage, ToolActivity } from '@shared/types'

/**
 * 「历史里摘掉、点开再取」这一对动作,合起来必须**看得到全部**。
 *
 * ★★这份测试守的是那条最容易写错、而且错了完全不报错的路:
 *  取单条时如果把 `omitOver` 也一起传下去,那一条会被**再摘一次** ——
 *  于是点开永远是空的,而屏幕上只会显示「这个工具没有回传输出」,看着像这条命令本来就没输出。
 */

const tool = (output: string, over: Partial<ToolActivity> = {}): ToolActivity =>
  ({ id: 't1', title: '调用 shell', status: 'ok', output, ...over })
const msg = (tools: ToolActivity[]): ChatMessage =>
  ({ id: 'm1', who: 'ai', text: '好了', ts: '2026-09-04T00:00:00Z', tools })

const HIST = { lines: 200, bytes: 16 * 1024, omitOver: 1024 }

/** 服务端 `chat:tool-output` 的那几行,原样搬过来 —— 钉的就是它。 */
function fetchOne(msgs: ChatMessage[], messageId: string, toolId: string) {
  const t = msgs.find(m => m.id === messageId)?.tools?.find(x => x.id === toolId)
  if (!t?.output) return { output: '', outputLines: t?.outputLines }
  const cap = readCap({ toolOutputLines: 200, toolOutputBytes: 16 * 1024 })   // ★注意:没有 omitOver
  const capped = cap ? capToolOutput(t, cap) : t
  return { output: capped.output ?? '', outputLines: capped.outputLines ?? t.output.split('\n').length }
}

describe('摘掉 + 按需取,合起来看得到全部', () => {
  const long = Array.from({ length: 900 }, (_, i) => `第 ${i} 行`).join('\n')
  const original = [msg([tool(long)])]

  it('历史里确实摘掉了(这是省流量的前提)', () => {
    const h = capToolOutputs(original, HIST)
    expect(h[0].tools![0].output).toBeUndefined()
    expect(h[0].tools![0].outputOmitted).toBe(true)
  })

  it('★★点开取回来的**不是空的** —— 取单条时绝不能再带 omitOver', () => {
    const got = fetchOne(original, 'm1', 't1')
    expect(got.output, '取单条时又被摘了一次').not.toBe('')
    expect(got.output.split('\n')[0]).toBe('第 0 行')
  })

  it('取回来的仍按调用方画得下的行数截断,并如实报原始行数', () => {
    const got = fetchOne(original, 'm1', 't1')
    expect(got.output.split('\n')).toHaveLength(200)
    expect(got.outputLines).toBe(900)
  })

  it('找不到消息 / 找不到工具 → 空串,不抛 —— 消息被清理不是错误', () => {
    expect(fetchOne(original, '不存在', 't1').output).toBe('')
    expect(fetchOne(original, 'm1', '不存在').output).toBe('')
  })

  it('本来就没有输出的工具:取回空串,而且行数也是空的(和「还没下载」区分得开)', () => {
    const none = [msg([{ id: 't1', title: '编辑文件', status: 'ok' } as ToolActivity])]
    const got = fetchOne(none, 'm1', 't1')
    expect(got.output).toBe('')
    expect(got.outputLines).toBeUndefined()
  })

  it('★小输出根本不进这条路 —— 历史里就带着,点开不用往返', () => {
    const small = [msg([tool('就一行')])]
    const h = capToolOutputs(small, HIST)
    expect(h[0].tools![0].output).toBe('就一行')
    expect(h[0].tools![0].outputOmitted).toBeUndefined()
  })
})
