import { describe, it, expect } from 'vitest'
import { clampHistory, renderHistoryPreamble } from './contextRebuild'
import type { ImportedMessage } from '@shared/types'

const mk = (n: number): ImportedMessage[] => Array.from({ length: n }, (_, i) => ({ who: i % 2 ? 'ai' : 'user', text: `m${i}`, ts: '' }))

describe('clampHistory', () => {
  it('按轮数裁剪保留尾部', () => {
    const { kept, omitted } = clampHistory(mk(50), { maxTurns: 30, maxTokens: 1e9 })
    expect(kept.length).toBe(30)
    expect(kept[0].text).toBe('m20')
    expect(omitted).toBe(20)
  })
  it('按 token 上限裁剪(字符/4)', () => {
    const big: ImportedMessage[] = [{ who: 'user', text: 'x'.repeat(40), ts: '' }, { who: 'ai', text: 'y'.repeat(40), ts: '' }]
    const { kept, omitted } = clampHistory(big, { maxTurns: 99, maxTokens: 12 }) // 12 tokens ≈ 48 chars; 一条40字符=10token
    expect(kept.length).toBe(1)
    expect(omitted).toBe(1)
  })
  it('全部放得下则不省略', () => {
    const { kept, omitted } = clampHistory(mk(5))
    expect(kept.length).toBe(5); expect(omitted).toBe(0)
  })
  it('单条超长消息被截断到 maxTokens*4 字符并含截断标记，omitted=0', () => {
    const longText = 'a'.repeat(200000) // 200000字符 ≈ 50000 tokens，超默认 40000
    const msgs: ImportedMessage[] = [{ who: 'user', text: longText, ts: '' }]
    const { kept, omitted } = clampHistory(msgs) // 使用默认 maxTokens=40000
    expect(kept.length).toBe(1)
    expect(omitted).toBe(0)
    const maxChars = 40000 * 4 // 160000
    const marker = '…(超长消息已截断)'
    expect(kept[0].text).toContain(marker)
    expect(kept[0].text.length).toBeLessThanOrEqual(maxChars + marker.length)
  })
})

describe('renderHistoryPreamble', () => {
  it('空返回空串', () => { expect(renderHistoryPreamble([], 0)).toBe('') })
  it('含角色与省略提示', () => {
    const s = renderHistoryPreamble([{ who: 'user', text: '你好', ts: '' }], 3)
    expect(s).toContain('更早历史已省略 3 条')
    expect(s).toContain('用户：你好')
  })
})
