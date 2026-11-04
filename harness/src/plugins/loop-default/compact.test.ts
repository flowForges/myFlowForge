import { describe, expect, it } from 'vitest'
import type { Message } from '../../lib/models/types'
import { compact, contextWindow, dropOldest, estimateTokens } from './compact'

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

  it('paged reads of one file are different reads: both pages are kept', () => {
    const m = [user('q'), call('c1', 'read', { path: 'big.ts', offset: 1 }), result('c1', big('1')), call('c2', 'read', { path: 'big.ts', offset: 2001 }), result('c2', big('2'))]
    const out = compact(m, { context: 2_500, keepRecentTokens: 10_000 })
    expect(contents(out)).toEqual([big('1'), big('2')])
  })

  it('a later failed read of the same range does not fold the earlier good one', () => {
    const err: Message = { role: 'tool', parts: [{ type: 'tool_result', callId: 'c2', content: big('e', 100), isError: true }] }
    const m = [user('q'), call('c1', 'read', { path: 'a' }), result('c1', big('1')), call('c2', 'read', { path: 'a' }), err]
    const out = compact(m, { context: 1_200, keepRecentTokens: 10_000 })
    expect(contents(out)[0]).toBe(big('1'))
  })

  it('the default recent window is min(24 000, 30 % of the context), so small contexts can still fold', () => {
    const m = [
      user('q'),
      call('c1', 'grep', { pattern: 'a' }), result('c1', big('1')),
      call('c2', 'grep', { pattern: 'b' }), result('c2', big('2')),
      call('c3', 'grep', { pattern: 'c' }), result('c3', big('3')),
      call('c4', 'grep', { pattern: 'd' }), result('c4', big('4')),
    ]
    // context 5000 → 窗口 1500:后两条受保护,前两条可折
    expect(contents(compact(m, { context: 5_000 }))).toEqual(['[已折叠:grep a,需要时重新读取]', '[已折叠:grep b,需要时重新读取]', big('3'), big('4')])
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

describe('compact with notices', () => {
  const notice = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] })
  it('never touches a notice, in or out of the recent window; the first user message stays first', () => {
    const big = 'x'.repeat(20_000)
    const msgs: Message[] = [
      { role: 'user', parts: [{ type: 'text', text: '<environment>E</environment>' }, { type: 'text', text: 'first' }] },
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'grep', args: '{"pattern":"p"}' }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: big }] },
      notice(`<executor-notice>old ${big}</executor-notice>`),
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'c2', name: 'grep', args: '{"pattern":"q"}' }] },
      { role: 'tool', parts: [{ type: 'tool_result', callId: 'c2', content: big }] },
      notice('<executor-notice>recent</executor-notice>'),
    ]
    const out = compact(msgs, { context: 10_000, keepRecentTokens: 1 })
    expect(out[2].parts[0]).toMatchObject({ content: expect.stringMatching(/^\[已折叠/) })
    expect(out[0]).toEqual(msgs[0])
    expect(out[3]).toEqual(msgs[3])
    expect(out[6]).toEqual(msgs[6])
    expect(out.map(m => m.role)).toEqual(msgs.map(m => m.role))
  })
})

describe('dropOldest (06 spec §12)', () => {
  const FIRST = user('FIRST')
  const placeholder = (n: number) => `[已省略较早的 ${n} 条消息,可以用 memory_search 搜回来]`
  const text = (m: Message) => m.parts.map(p => (p.type === 'text' ? p.text : p.type)).join('|')
  const say = (t: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text: t }] })
  const drop = (m: Message[], o: Partial<Parameters<typeof dropOldest>[1]> = {}) => dropOldest(m, { context: 1000, target: 0.6, keepRecent: 0, currentOpening: -1, ...o })

  /** call → result 对,每对约 200 token */
  const pairs = (n: number) => Array.from({ length: n }, (_, i) => [call(`c${i}`, 'read', { path: `${i}` }), result(`c${i}`, big(`${i % 10}`, 700))]).flat()

  it('under the target: the same messages, a new array', () => {
    const m = [FIRST, say('a')]
    const out = drop(m)
    expect(out).toEqual(m)
    expect(out).not.toBe(m)
  })

  it('removes from index 1 until the target, leaving the placeholder, and every tool_call keeps its result', () => {
    const m = [FIRST, ...pairs(6)]
    const out = drop(m)
    expect(text(out[0])).toBe('FIRST')
    expect(estimateTokens(out)).toBeLessThanOrEqual(600)
    const kept = (out.length - 2) / 2
    expect(text(out[1])).toBe(placeholder(12 - kept * 2))
    expectPaired(out)
  })

  it('never starts the tail on a tool message', () => {
    for (let target = 0.05; target < 1; target += 0.05) {
      const out = drop([FIRST, ...pairs(6)], { target })
      expectPaired(out)
      expect(out[2]?.role).not.toBe('tool')
    }
  })

  it('keeps at least the last step, however low the target', () => {
    const out = drop([FIRST, ...pairs(3)], { target: 0.001 })
    expect(out.map(m => m.role)).toEqual(['user', 'user', 'assistant', 'tool'])
    expect(text(out[1])).toBe(placeholder(4))
  })

  it('a tail may start on a user message or on a plain assistant step', () => {
    const atUser = drop([FIRST, ...pairs(2), user('MID'), result2('x')], { target: 0.1 })
    expect(atUser.slice(2).map(m => m.role)[0]).toMatch(/user|assistant/)
    const out = drop([FIRST, ...pairs(3), say('END')], { target: 0.001 })
    expect(text(out[out.length - 1])).toBe('END')
  })

  it('keepRecent holds back a drop that would leave too little of the tail', () => {
    const m = [FIRST, ...pairs(6)]
    const free = drop(m, { target: 0.01 })
    const held = drop(m, { target: 0.01, keepRecent: 500 })
    expect(free.length).toBeLessThan(held.length)
    expect(estimateTokens(held.slice(2))).toBeGreaterThanOrEqual(500)
    expectPaired(held)
  })

  it('index 0: the last text part is clipped to 4000, the environment and session parts stay', () => {
    const first: Message = { role: 'user', parts: [{ type: 'text', text: 'E'.repeat(5000) }, { type: 'text', text: 'B'.repeat(50_000) }] }
    const out = dropOldest([first, say('a')], { context: 10_000, target: 0.6, keepRecent: 0, currentOpening: -1 })
    expect((out[0].parts[0] as { text: string }).text).toBe('E'.repeat(5000))
    const body = (out[0].parts[1] as { text: string }).text
    expect(body.length).toBeLessThanOrEqual(4000)
    expect(body.startsWith('BBB')).toBe(true)
    expect(first.parts[1]).toEqual({ type: 'text', text: 'B'.repeat(50_000) }) // 不改入参
  })

  it('clipping alone may be enough: no placeholder then', () => {
    const first = user('B'.repeat(50_000))
    const out = dropOldest([first, say('a'), say('b')], { context: 10_000, target: 0.6, keepRecent: 0, currentOpening: -1 })
    expect(out).toHaveLength(3)
  })

  it('the current opening stays whole, at index 0 too', () => {
    const huge = user('C'.repeat(3000))
    const m = [FIRST, ...pairs(3), huge, ...pairs(3)]
    const out = drop(m, { currentOpening: 7, target: 0.2 })
    expect(out.filter(x => x === huge)).toHaveLength(1)
    expect(text(out[0])).toBe('FIRST')
    expect(text(out[1])).toBe(placeholder(6))
    expect(out[2]).toBe(huge)
    expectPaired(out)

    const opening = user('D'.repeat(5000))
    const atZero = dropOldest([opening, ...pairs(6)], { context: 1000, target: 0.6, keepRecent: 0, currentOpening: 0 })
    expect(atZero[0]).toBe(opening)
    expectPaired(atZero)
  })

  describe('the current turn is never cut (review I2)', () => {
    const say2 = (t: string): Message => ({ role: 'assistant', parts: [{ type: 'text', text: t }] })
    const OPENING = user('OPENING')
    const FOLLOW = user('FOLLOW-UP stop and do X instead')
    const turn = () => [OPENING, call('a', 'read', { path: 'a' }), result('a', 'A'.repeat(9000)), FOLLOW, say2('STEP-TEXT'), call('b', 'read', { path: 'b' }), result('b', 'B'.repeat(9000)), call('c', 'read', { path: 'c' }), result('c', 'small')]
    const earlier = () => [user('older'), call('o', 'read', { path: 'o' }), result('o', 'O'.repeat(700))]
    const opts = (n: number) => ({ context: 1000, keepRecent: 0, currentOpening: n })

    it('only earlier turns go; follow-ups, steps and results of this turn all stay, and the note sits at the gap', () => {
      const m = [FIRST, ...earlier(), ...turn()]
      const out = dropOldest(m, { ...opts(4), target: 5.3 })
      expect(out.map(text)).toEqual(['FIRST', placeholder(3), ...turn().map(text)])
      expect(out[2]).toBe(m[4])
      expectPaired(out)
    })

    it('still over: the oldest large results are clipped in place, marked, oldest first, and stop when it fits', () => {
      const m = [FIRST, ...earlier(), ...turn()]
      const out = dropOldest(m, { ...opts(4), target: 3.9 })
      const results = out.flatMap(x => x.parts).flatMap(p => (p.type === 'tool_result' ? [p] : []))
      expect(results.map(r => r.callId)).toEqual(['a', 'b', 'c'])
      expect(results[0].content.length).toBeLessThan(3000)
      expect(results[0].content.startsWith('AAA')).toBe(true)
      expect(results[0].content).toMatch(/\[结果太长,已截断:原文 9000 字,需要时重新读取或用 memory_search 搜\]$/)
      expect(results[1].content).toBe('B'.repeat(9000))
      expect(results[2].content).toBe('small')
      expect(estimateTokens(out)).toBeLessThanOrEqual(3900)
      expect(out.some(x => x === FOLLOW)).toBe(true)
      expectPaired(out)
    })

    it('all of them clipped and still over: nothing is dropped, and clipping again changes nothing', () => {
      const m = [FIRST, ...turn()]
      const out = dropOldest(m, { ...opts(1), target: 0.01 })
      expect(out.map(x => x.role)).toEqual(m.map(x => x.role))
      expect(text(out[1])).toBe('OPENING')
      expect(out.some(x => x === FOLLOW)).toBe(true)
      expect(out.flatMap(x => x.parts).flatMap(p => (p.type === 'tool_result' ? [p.content.length] : [])).every(n => n < 3000)).toBe(true)
      expect(dropOldest(out, { ...opts(1), target: 0.01 })).toEqual(out)
      expectPaired(out)
    })

    it('an error flag and a surrogate pair survive the clip', () => {
      const big: Message = { role: 'tool', parts: [{ type: 'tool_result', callId: 'a', content: '😀'.repeat(5000), isError: true }] }
      const m = [OPENING, call('a', 'read', {}), big]
      const out = dropOldest(m, { ...opts(0), target: 0.01 })
      const r = out[2].parts[0] as { content: string; isError?: boolean }
      expect(r.isError).toBe(true)
      expect(r.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    })

    it('with no current turn given, nothing is clipped', () => {
      const m = [FIRST, ...turn()]
      const out = dropOldest(m, { context: 1000, keepRecent: 0, currentOpening: -1, target: 0.01 })
      expect(out.flatMap(x => x.parts).flatMap(p => (p.type === 'tool_result' ? [p.content] : [])).join()).not.toContain('已截断')
    })
  })

  it('a checkpoint right after the first message stays: it is the only record of what it covers', () => {
    const cp = user('<checkpoint through="9">\nsummary\n</checkpoint>')
    const out = drop([FIRST, cp, ...pairs(6)], { target: 0.2 })
    expect(out[1]).toBe(cp)
    expect(text(out[2])).toMatch(/^\[已省略较早的/)
    expectPaired(out)
  })

  it('dropping again adds to the earlier count', () => {
    const m = [FIRST, ...pairs(8)]
    const once = drop(m, { target: 0.6 })
    const onceN = Number(/(\d+) 条/.exec(text(once[1]))![1])
    const twice = drop(once, { target: 0.3 })
    const twiceN = Number(/(\d+) 条/.exec(text(twice[1]))![1])
    expect(twice.filter(x => text(x).startsWith('[已省略'))).toHaveLength(1)
    expect(twiceN).toBe(m.length - (twice.length - 1))
    expect(twiceN).toBeGreaterThan(onceN)
    expectPaired(twice)
  })

  it('is deterministic and does not change its input', () => {
    const m = [FIRST, ...pairs(6)]
    const copy = structuredClone(m)
    expect(drop(m)).toEqual(drop(m))
    expect(m).toEqual(copy)
  })

  it('one message: nothing to remove', () => {
    expect(drop([user('x'.repeat(100))], { target: 0.0001 })).toHaveLength(1)
  })

  it('compact never touches the first message of a rebuilt history', () => {
    const first = user('E'.repeat(10_000))
    const cp = user('<checkpoint through="1">\ns\n</checkpoint>')
    const out = compact([first, cp, ...pairs(30)], { context: 1000, keepRecentTokens: 0 })
    expect(out[0]).toBe(first)
    expect(out[1]).toBe(cp)
  })
})

function result2(t: string): Message {
  return { role: 'assistant', parts: [{ type: 'text', text: t }] }
}

function expectPaired(messages: Message[]) {
  messages.forEach((m, i) => {
    const calls = m.parts.flatMap(p => (p.type === 'tool_call' ? [p.id] : []))
    const results = m.parts.flatMap(p => (p.type === 'tool_result' ? [p.callId] : []))
    if (calls.length) {
      const next = messages[i + 1]
      expect(next?.role).toBe('tool')
      expect(next.parts.map(p => (p.type === 'tool_result' ? p.callId : ''))).toEqual(calls)
    }
    if (results.length) expect(messages[i - 1]?.parts.flatMap(p => (p.type === 'tool_call' ? [p.id] : []))).toEqual(results)
  })
}
