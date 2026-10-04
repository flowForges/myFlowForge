import { describe, it, expect } from 'vitest'
import { DESKTOP_TOOL_OUTPUT_CAP } from './toolOutput'
import { readCap, capToolOutputs } from '../../../main/chat/toolOutputCap'
import type { ChatMessage } from '@shared/types'

// ★★这条测试**跨两边**:渲染端给的上限(DESKTOP_TOOL_OUTPUT_CAP)和主进程的截断器
//  (main/chat/toolOutputCap.ts)必须对得上。只测一边的话,改了常量却没人发现语义变了 ——
//  比如把 lines 改小,内联的输出会被**静默截断**,而电脑端屏幕明明画得下。
const msg = (tools: { id: string; output: string }[]): ChatMessage => ({
  id: 'm1', who: 'ai', text: '', ts: '2026-10-03T00:00:00.000Z',
  tools: tools.map(t => ({ ...t, title: 't', status: 'ok' as const })),
}) as ChatMessage

describe('电脑端的工具输出上限 —— 只按需取,不截断', () => {
  const cap = readCap({ ...DESKTOP_TOOL_OUTPUT_CAP })

  it('主进程认得这份上限(给错数的话 readCap 会返回 null = 整份全量下发)', () => {
    expect(cap).not.toBeNull()
    expect(cap!.omitOver).toBe(4096)
  })

  it('4KB 以内的输出照旧内联,而且一个字都不少', () => {
    const small = 'x'.repeat(4096)
    const out = capToolOutputs([msg([{ id: 't1', output: small }])], cap!)
    expect(out[0].tools![0].output).toBe(small)
    expect(out[0].tools![0].outputOmitted).toBeUndefined()
  })

  it('超过 4KB 的整段不下发,但「共几行」照旧说真话(不是 0)', () => {
    const big = Array.from({ length: 5291 }, (_, i) => `line ${i}`).join('\n')
    const out = capToolOutputs([msg([{ id: 't1', output: big }])], cap!)
    expect(out[0].tools![0].output).toBeUndefined()
    expect(out[0].tools![0].outputOmitted).toBe(true)
    expect(out[0].tools![0].outputLines).toBe(5291)
  })

  it('★内联的那些永远不会被行数/字节上限截到(电脑端不做静默截断)', () => {
    // 4096 字节能装下的最多行数 = 全是换行的那种;lines 上限必须比它大
    expect(DESKTOP_TOOL_OUTPUT_CAP.toolOutputLines).toBeGreaterThan(4096)
    expect(DESKTOP_TOOL_OUTPUT_CAP.toolOutputBytes).toBeGreaterThan(4096)
    const allNewlines = '\n'.repeat(4000)
    const out = capToolOutputs([msg([{ id: 't1', output: allNewlines }])], cap!)
    expect(out[0].tools![0].output).toBe(allNewlines)
  })
})
