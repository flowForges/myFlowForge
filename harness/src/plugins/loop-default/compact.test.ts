import { describe, expect, it } from 'vitest'
import type { Message } from '../../lib/models/types'
import { compact, contextWindow, estimateTokens } from './compact'

const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })
const call = (id: string, name: string, args: object): Message => ({ role: 'assistant', parts: [{ type: 'tool_call', id, name, args: JSON.stringify(args) }] })
const result = (id: string, content: string): Message => ({ role: 'tool', parts: [{ type: 'tool_result', callId: id, content }] })
const contents = (m: Message[]) => m.flatMap(x => x.parts).flatMap(p => (p.type === 'tool_result' ? [p.content] : []))
const big = (c: string, n = 3500) => c.repeat(n) // 3500 字符 ≈ 1000 token

describe('estimateTokens', () => {
  it('is total characters / 3.5 over text, tool calls and results', () => {
    expect(estimateTokens([user('x'.repeat(35))])).toBe(10)
    expect(estimateTokens([call('c', 'read', {}), result('c', 'y'.repeat(31))])).toBe(Math.ceil(('read{}'.length + 31) / 3.5))
  })
})

describe('compact', () => {
  it('never folds when under the threshold, and returns a new array', () => {
    const m = [user('q'), call('c1', 'read', { path: 'a.txt' }), result('c1', big('a')), call('c2', 'read', { path: 'a.txt' }), result('c2', big('b'))]
    const out = compact(m, { context: 100_000 })
    expect(out).toEqual(m)
    expect(out).not.toBe(m)
  })

  it('repeated reads of the same resolved path keep only the latest', () => {
    const m = [
      user('q'),
      call('c1', 'read', { path: 'src/a.ts' }), result('c1', big('1')),
      call('c2', 'read', { path: './src/../src/a.ts' }), result('c2', big('2')),
      call('c3', 'read', { path: 'b.ts' }), result('c3', big('3')),
      call('c4', 'read', { path: '/w/src/a.ts' }), result('c4', big('4')),
    ]
    // 4000 token 的消息,阈值 0.7 × 5000 = 3500:超过;第一遍折掉两份旧的 a.ts 后降到阈值以下
    const out = compact(m, { context: 5_000, keepRecentTokens: 0, cwd: '/w' })
    expect(contents(out)).toEqual(['[已折叠:read src/a.ts,需要时重新读取]', '[已折叠:read ./src/../src/a.ts,需要时重新读取]', big('3'), big('4')])
  })

  it('then folds the oldest tool results first until below the low mark', () => {
    const m = [
      user('q'),
      call('c1', 'grep', { pattern: 'foo' }), result('c1', big('1')),
      call('c2', 'shell', { command: 'npm test' }), result('c2', big('2')),
      call('c3', 'list', { path: 'src' }), result('c3', big('3')),
      call('c4', 'glob', { pattern: '*.ts' }), result('c4', big('4')),
    ]
    // 4000 token,context 5000:高水位 3500、低水位 2500 → 从最旧的折两条
    const out = compact(m, { context: 5_000, keepRecentTokens: 0 })
    expect(contents(out)).toEqual(['[已折叠:grep foo,需要时重新读取]', '[已折叠:shell npm test,需要时重新读取]', big('3'), big('4')])
    expect(estimateTokens(out)).toBeLessThanOrEqual(2_500)
  })

  it('never folds inside the most recent keepRecentTokens', () => {
    const m = [
      user('q'),
      call('c1', 'grep', { pattern: 'a' }), result('c1', big('1')),
      call('c2', 'grep', { pattern: 'b' }), result('c2', big('2')),
      call('c3', 'grep', { pattern: 'c' }), result('c3', big('3')),
      call('c4', 'grep', { pattern: 'd' }), result('c4', big('4')),
    ]
    // 最近 2500 token 覆盖后三条结果:只能折第一条,降不到低水位也停
    const out = compact(m, { context: 5_000, keepRecentTokens: 2_500 })
    expect(contents(out)).toEqual(['[已折叠:grep a,需要时重新读取]', big('2'), big('3'), big('4')])
  })

  it('never touches user messages, including the first one with the environment block', () => {
    const env = `<environment>${'e'.repeat(7000)}</environment>`
    const m: Message[] = [{ role: 'user', parts: [{ type: 'text', text: env }, { type: 'text', text: 'q' }] }, call('c1', 'grep', { pattern: 'a' }), result('c1', big('1'))]
    const out = compact(m, { context: 2_000, keepRecentTokens: 0 })
    expect(out[0]).toEqual(m[0])
    expect(contents(out)).toEqual(['[已折叠:grep a,需要时重新读取]'])
  })

  it('does not mutate the input and is deterministic', () => {
    const m = [user('q'), call('c1', 'read', { path: 'a' }), result('c1', big('1')), call('c2', 'read', { path: 'a' }), result('c2', big('2'))]
    const before = structuredClone(m)
    const a = compact(m, { context: 2_000, keepRecentTokens: 0 })
    const b = compact(m, { context: 2_000, keepRecentTokens: 0 })
    expect(m).toEqual(before)
    expect(a).toEqual(b)
    expect(a[2]).not.toBe(m[2])
    expect(a[0]).toBe(m[0]) // 没改的消息原样复用
  })

  it('pairs a reused call id with its most recent call', () => {
    const m = [user('q'), call('c', 'read', { path: 'a' }), result('c', big('1')), call('c', 'grep', { pattern: 'z' }), result('c', big('2')), call('d', 'read', { path: 'a' }), result('d', big('3'))]
    const out = compact(m, { context: 4_000, keepRecentTokens: 0 })
    expect(contents(out)[0]).toBe('[已折叠:read a,需要时重新读取]')
    expect(contents(out)[1]).toBe(big('2')) // grep 的结果不算 read
  })
})

describe('contextWindow', () => {
  const models = {
    accounts: () => [{ id: 'acc', presetId: 'p', label: '', state: 'ok' as const, models: [{ id: 'own', name: '', context: 64_000, output: 1, image: false, reasoning: 'none' as const, toolCall: true }] }],
    catalog: () => ({ presets: [], models: { p: [{ id: 'cat', name: '', context: 200_000, output: 1, image: false, reasoning: 'none' as const, toolCall: true }] }, default: { accountId: 'acc', modelId: 'cat' } }),
  }
  it('reads the account model list, then the catalog preset, default 128 000', () => {
    expect(contextWindow(models, { accountId: 'acc', modelId: 'own' })).toBe(64_000)
    expect(contextWindow(models, { accountId: 'acc', modelId: 'cat' })).toBe(200_000)
    expect(contextWindow(models, 'default')).toBe(200_000)
    expect(contextWindow(models, { accountId: 'acc', modelId: 'nope' })).toBe(128_000)
    expect(contextWindow(models, { accountId: 'x', modelId: 'cat' })).toBe(128_000)
  })
})
