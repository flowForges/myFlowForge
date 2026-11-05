import { describe, expect, it } from 'vitest'
import { scrub } from '../../lib/memory/scrub'
import type { KernelEvent } from '../../protocol/index'
import { renderTurn, SEGMENT_CHUNKS, TRUNCATED, type Chunk } from './render'

const T = 'turn-1'
let seq = 0
const ev = (type: string, payload: object = {}): KernelEvent => ({ seq: ++seq, ts: 1, type: type as KernelEvent['type'], sessionId: 's1', payload: { turnId: T, ...payload } })
const delta = (text: string, step?: number) => ev('message.assistant.delta', { text, ...(step !== undefined && { step }) })
const idMask = (s: string) => s
const mask = (s: string) => scrub(s).text
const render = (events: KernelEvent[], o: Partial<{ final: boolean; queued: number; mask: (s: string) => string; cwd: string }> = {}) =>
  renderTurn(events, { turnId: T, final: false, queued: 0, mask, ...o })
const all = (cs: Chunk[]) => cs.map(c => c.text).join('\n')
const X = (n: number) => 'x'.repeat(n)
const mixed = (n: number) => Array.from({ length: n }, (_, i) => 'aZ3kQ9mB7xLp2WnR5tYc8VdF1hJ4gS6u'[(i * 7 + (i >> 2)) % 32]).join('')

const SECRETS: Array<[string, string]> = [
  ['openai', 'sk-' + X(24)],
  ['github', 'ghp_' + mixed(36)],
  ['telegram', '123456789:' + mixed(35)],
  ['stripe', 'sk_live_' + X(24)],
  ['jwt', ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0In0', 'c2lnbmF0dXJl'].join('.')],
  ['labelled', 'password=' + 'hunter' + mixed(10)],
  ['long random', mixed(40)],
  ['bearer', 'Bearer ' + mixed(24)],
  ['cn label', '密码:' + mixed(14)],
  ['url account', 'https://user:' + mixed(14) + '@host.example/x'],
]
const PEM = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMx', 'H2Mo4lgOEePzNm0tRgeLezV6ffAt0gun', '-----END ' + 'RSA PRIVATE KEY-----'].join('\n')

/** 秘密里最容易漏的部分:去掉标签后的值本身 */
const valueOf = (s: string) => s.replace(/^(?:Bearer |password=|密码:|https:\/\/user:)/, '').replace(/@host.*$/, '')

function leaks(secret: string, text: string): boolean {
  const v = valueOf(secret)
  for (let i = 0; i + 6 <= v.length; i++) if (text.includes(v.slice(i, i + 6))) return true
  return false
}

function perChar(wrap: (s: string) => string, secret: string, queued = 0, before: KernelEvent[] = []) {
  const full = wrap(secret)
  const events: KernelEvent[] = [...before]
  for (let i = 0; i < full.length; i++) {
    events.push(delta(full[i]!))
    const out = all(render(events, { queued }))
    expect(leaks(secret, out), `leak at char ${i}, queued ${queued}: ${out.slice(-60)}`).toBe(false)
  }
  return events
}

describe.each([0, 1, 3])('renderTurn: secrets at every moment of the stream, queued %i', queued => {
  for (const [name, secret] of SECRETS) {
    it(`${name}: plain, in Chinese, in a fence, across a step`, () => {
      const plain = perChar(s => `请看 ${s} 完毕。`, secret, queued)
      expect(all(render([...plain, ev('message.assistant', { text: `请看 ${secret} 完毕。` })], { final: true, queued }))).toContain('***')
      perChar(s => `这是中文说明,${s}然后继续`, secret, queued)
      perChar(s => '```sh\nexport K=' + s + '\n```\n', secret, queued)
      // the step ends right after the secret, then the next step streams on
      const text = `用 ${secret} 即可`
      const evs = [...perChar(s => `用 ${s} 即可`, secret, queued), ev('message.assistant', { text })]
      for (const tail of ['下一步', ' next step']) {
        const more = [...evs]
        for (const ch of tail) {
          more.push(delta(ch))
          expect(leaks(secret, all(render(more, { queued })))).toBe(false)
        }
      }
    })
    it(`${name}: a parked turn's tail line and a follow-up segment`, () => {
      perChar(s => `请看 ${s} 完毕。`, secret, queued, [ev('turn.parked')])
      // the follow-up streams into its own segment, which is the last one and carries the tail lines
      perChar(s => `请看 ${s} 完毕。`, secret, queued, [delta('前面'), ev('message.assistant', { text: '前面' }), ev('message.user', { followUp: true })])
    })
  }
  it('PEM body never appears before the END line', () => {
    const events: KernelEvent[] = []
    for (let i = 0; i < PEM.length; i++) {
      events.push(delta(PEM[i]!))
      const out = all(render(events, { queued }))
      expect(out).not.toContain('MIIEowIBAAKC'.slice(0, 6))
      expect(out).not.toContain('H2Mo4l')
    }
  })
  it('the tail line itself still shows', () => {
    if (queued > 0) expect(all(render([delta('今天天气不错')], { queued }))).toBe(`今天天气不错\n已收到 ${queued} 条`)
    expect(all(render([delta('key is sk-abc')], { queued }))).not.toContain('sk-abc')
  })
})

describe('renderTurn: the rest of the stream', () => {
  it('PEM body never appears before the END line, and is masked after', () => {
    const events: KernelEvent[] = []
    for (let i = 0; i < PEM.length; i++) {
      events.push(delta(PEM[i]!))
      const out = all(render(events))
      expect(out).not.toContain('MIIEowIBAAKC'.slice(0, 6))
      expect(out).not.toContain('H2Mo4l')
    }
    const done = all(render([...events, ev('message.assistant', { text: PEM }), ev('turn.ended')], { final: true }))
    expect(done).not.toContain('MIIEow')
  })
  it('non-secret Chinese text still streams before the turn ends', () => {
    const out = all(render([delta('今天天气不错,我们'), delta('去公园走走')]))
    expect(out).toBe('今天天气不错,我们去公园走走')
  })
  it('known gap: an unlabelled low-entropy value goes out', () => {
    const v = 'hunter2hunter2'
    expect(all(render([delta(`the value is ${v} ok`), ev('message.assistant', { text: `the value is ${v} ok` })], { final: true }))).toContain(v)
  })
  it('known gap: a secret split across two messages goes out', () => {
    const s = 'sk-' + X(24)
    const a = all(render([ev('message.assistant', { step: 0, text: 'sk-' + X(10) })], { final: true }))
    expect(a).toContain('sk-' + X(10))
    expect(s.length).toBeGreaterThan(a.length)
  })
  it('tool output, reasoning and failure message never appear', () => {
    const marker = 'MARKER' + 'ZZ9'
    const out = all(render([
      ev('tool.started', { callId: 'c', name: 'read', argsPreview: '{"path":"a.ts"}' }),
      ev('tool.ended', { callId: 'c', name: 'read', ok: true, ms: 1, content: marker + ' sk-' + X(24) }),
      ev('message.reasoning.delta', { text: marker }),
      ev('turn.failed', { reason: 'error', message: marker + ' https://acct@host' }),
    ], { final: true }))
    expect(out).not.toContain(marker)
    expect(out).toContain('▸ read a.ts')
  })
})

describe('renderTurn: text path', () => {
  it('message.assistant replaces the delta text when the step ends', () => {
    const out = render([delta('draft '), ev('message.assistant', { text: 'final answer' })])
    expect(all(out)).toBe('final answer')
  })
  it('two steps are two paragraphs, with tool lines between', () => {
    const out = render([
      delta('one ', 0), ev('message.assistant', { step: 0, text: 'one' }),
      ev('tool.started', { callId: 'c', name: 'read', argsPreview: '{"path":"a.ts"}' }),
      ev('tool.ended', { callId: 'c', name: 'read', ok: true, ms: 1, content: '' }),
      delta('two', 1), ev('message.assistant', { step: 1, text: 'two' }), ev('turn.ended'),
    ], { final: true })
    expect(all(out)).toBe('one\n▸ read a.ts\ntwo')
  })
  it('entities survive masking', () => {
    const out = render([ev('message.assistant', { text: '**好**😀 `c`' })], { final: true })
    expect(out[0]!.text).toBe('好😀 c')
    expect(out[0]!.entities.map(e => out[0]!.text.slice(e.offset, e.offset + e.length))).toEqual(['好', 'c'])
  })
  it('is deterministic', () => {
    const evs = [delta('a **b** '), ev('tool.started', { callId: 'c', name: 'shell', argsPreview: '{"command":"ls"}' }), ev('approval.requested', { approvalId: 'x', callId: 'c', tool: 'shell', summary: 'ls' }), delta('后')]
    expect(JSON.stringify(render(evs))).toBe(JSON.stringify(render(evs)))
  })
  it('empty turn renders nothing', () => {
    expect(render([ev('turn.started')])).toEqual([])
  })
  it('queued adds a tail line', () => {
    expect(all(render([ev('message.assistant', { text: 'hi' })], { queued: 2 }))).toBe('hi\n已收到 2 条')
  })
  it('1 MB of deltas renders under 200 ms', () => {
    const evs: KernelEvent[] = []
    for (let i = 0; i < 1_000_000 / 10; i++) evs.push(delta('012345678 '))
    const t = performance.now()
    const out = render(evs, { mask: idMask })
    expect(performance.now() - t).toBeLessThan(200)
    expect(out.length).toBe(12)
  })
})

describe('renderTurn: chunking', () => {
  it('chunks fit, notify only on the first', () => {
    const out = render([ev('message.assistant', { text: ('段落😀'.repeat(20) + '\n').repeat(300) })], { final: true })
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(4096)
    expect(out[0]!.notify).toBe(true)
    expect(out.slice(1).every(c => !c.notify)).toBe(true)
  })
  it('a secret straddling the 50 000 mark is masked whole, even when masking shrinks the text below the cap', () => {
    const token = 'ghp_' + 'aZ3kQ9mB7xLp2WnR5tYc'.repeat(2).slice(0, 36)
    let body = ''
    for (let i = 0; i < 200; i++) body += `sk-${'x'.repeat(24)}\n`
    body += 'filler '.repeat(Math.ceil((49_980 - body.length) / 7))
    body = body.slice(0, 49_980) + token + ' tail'
    const out = render([ev('message.assistant', { text: body })], { final: true })
    const all = out.map(c => c.text).join('')
    for (let i = 0; i + 6 <= token.length; i++) expect(all).not.toContain(token.slice(i, i + 6))
    expect(all).not.toContain('sk-xxx')
  })

  it('clipped text shows the notice even when markers shrink it under 12 chunks', () => {
    const out = render([ev('message.assistant', { text: '**a** '.repeat(12_000) })], { final: true })
    expect(out.length).toBeLessThanOrEqual(SEGMENT_CHUNKS)
    expect(out.at(-1)?.text.endsWith(TRUNCATED)).toBe(true)
    expect(out.map(c => c.text).join('').split(TRUNCATED)).toHaveLength(2)
  })

  it('mid-stream, a run of ASCII past the clip stays held back: clipping cannot end it early', () => {
    expect(render([delta('x'.repeat(60_000))])).toEqual([])
  })

  it('1 MB through the real scrub stays bounded', () => {
    const started = performance.now()
    const out = render([delta('word '.repeat(200_000))], { final: true })
    expect(out.at(-1)?.text.endsWith(TRUNCATED)).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('text under the clip has no notice', () => {
    expect(render([ev('message.assistant', { text: 'short' })], { final: true }).at(-1)?.text).toBe('short')
  })

  it.each([
    ['bold', `sk-${'a'.repeat(14)}**${'b'.repeat(14)}**${'c'.repeat(14)}`],
    ['code', `sk-${'a'.repeat(14)}\`${'b'.repeat(14)}\`${'c'.repeat(14)}`],
  ])('%s markers inside a secret cannot reassemble it after stripping', (_name, secret) => {
    const out = render([ev('message.assistant', { text: `**keep** ${secret} end` })], { final: true })
    const all = out.map(c => c.text).join('')
    expect(all).not.toContain('a'.repeat(14) + 'b'.repeat(6))
    expect(all).not.toContain('b'.repeat(14) + 'c'.repeat(6))
    expect(all).toContain('keep')
    expect(all).toContain('keep *** end')
    expect(out[0].entities).toEqual([])
  })

  it('masked text keeps its entities when stripping reveals nothing', () => {
    const out = render([ev('message.assistant', { text: `**keep** sk-${'x'.repeat(24)} end` })], { final: true })
    expect(out[0].entities).toEqual([{ type: 'bold', offset: 0, length: 4 }])
    expect(out[0].text).not.toContain('xxxxxx')
  })

  it('50 000 chars → 12 chunks and the notice on the last', () => {
    const out = render([ev('message.assistant', { text: 'a'.repeat(50_000) })], { final: true })
    expect(out.length).toBe(12)
    expect(out[11]!.text.endsWith('已截断,完整内容在 app 里')).toBe(true)
    expect(out[11]!.text.length).toBeLessThanOrEqual(4096)
    expect(out[10]!.text).not.toContain('已截断')
  })
  it('an approval is a break: later output starts a new chunk', () => {
    const out = render([delta('before'), ev('approval.requested', { approvalId: 'a', callId: 'c', tool: 'shell', summary: 's' }), delta('after')], { final: true })
    expect(out.map(c => c.text)).toEqual(['before', 'after'])
  })
  it('a parked turn: 13-chunk answer, follow-up reply goes to new notifying chunks', () => {
    const out = render([
      ev('message.user', { text: 'go' }),
      ev('message.assistant', { step: 0, text: 'a'.repeat(60_000) }),
      ev('turn.parked', { step: 1, active: 1, pending: 0 }),
      ev('message.user', { text: 'more', followUp: true }),
      ev('turn.resumed', { step: 1, cause: 'followUp' }),
      ev('message.assistant', { step: 1, text: '后续回复' }),
      ev('turn.ended'),
    ], { final: true })
    expect(out.length).toBe(13)
    expect(out[11]!.text).toContain('已截断')
    expect(out[12]).toMatchObject({ text: '后续回复', notify: true })
    expect(out.filter(c => c.notify).length).toBe(2)
  })
})

describe('renderTurn: tool lines', () => {
  const tool = (name: string, args: string, id = name) => ev('tool.started', { callId: id, name, argsPreview: args })
  const lines = (evs: KernelEvent[], o = {}) => all(render(evs, o)).split('\n')
  it.each([
    ['read', '{"path":"src/a.ts"}', '▸ read src/a.ts'],
    ['write', '{"path":"b.md","content":"zz"}', '▸ write b.md'],
    ['edit', '{"path":"c.ts","old":"a","new":"b"}', '▸ edit c.ts'],
    ['list', '{"path":"src"}', '▸ list src'],
    ['list', '{}', '▸ list'],
    ['glob', '{"pattern":"**/*.ts"}', '▸ glob **/*.ts'],
    ['grep', '{"pattern":"foo.*","path":"src"}', '▸ grep foo.*'],
    ['shell', '{"command":"npm test"}', '▸ shell npm test'],
    ['apply_patch', '{"patch":"*** Begin Patch"}', '▸ apply_patch'],
    ['memory_search', '{"query":"my private thing"}', '▸ memory_search'],
    ['memory_write', '{"text":"private"}', '▸ memory_write'],
    ['delegate_codex', '{"prompt":"fix the secret bug"}', '▸ delegate_codex'],
    ['unknown_tool', '{"path":"/etc/passwd"}', '▸ unknown_tool'],
  ])('%s', (name, args, line) => {
    expect(lines([tool(name, args)])).toEqual([line])
  })
  it('malformed argsPreview falls back, a clipped one is read leniently', () => {
    expect(lines([tool('read', 'not json')])).toEqual(['▸ read'])
    expect(lines([tool('read', '')])).toEqual(['▸ read'])
    expect(lines([tool('read', '{"path": 5}')])).toEqual(['▸ read'])
    expect(lines([tool('read', '{"path":"src/long.ts","x":"cut off…')])).toEqual(['▸ read src/long.ts'])
    expect(lines([tool('weird name\nwith newline', '{}')])).toEqual(['▸ tool'])
  })
  it('shell secret is masked before it is clipped to 80', () => {
    const secret = 'sk-' + X(30)
    const cmd = 'curl -H "Authorization: Bearer ' + mixed(24) + '" https://api.example/' + 'a'.repeat(100) + ' ' + secret
    const l = lines([tool('shell', JSON.stringify({ command: cmd }))])[0]!
    expect(l).not.toContain(mixed(24).slice(0, 8))
    expect(l).not.toContain('sk-xxxx')
    expect(l.length).toBeLessThanOrEqual('▸ shell '.length + 81)
    // a secret straddling the cut is still gone
    const cmd2 = 'a'.repeat(70) + ' ' + secret
    const l2 = lines([tool('shell', JSON.stringify({ command: cmd2 }))])[0]!
    expect(l2).not.toContain('sk-xxxx')
    expect(l2).not.toContain('xxxxxxxx')
  })
  it('absolute paths: relative inside cwd, base name outside, never absolute', () => {
    const cwd = '/Users/alice/work/proj'
    const l = lines([
      tool('read', JSON.stringify({ path: cwd + '/src/a.ts' }), '1'),
      tool('read', JSON.stringify({ path: '/Users/alice/.ssh/id_rsa' }), '2'),
      tool('shell', JSON.stringify({ command: `cat ${cwd}/x.txt /var/log/system.log ~/notes/a.md && cd ${cwd}` }), '3'),
      tool('write', JSON.stringify({ path: cwd }), '4'),
    ], { cwd })
    expect(l[0]).toBe('▸ read src/a.ts')
    expect(l[1]).toBe('▸ read id_rsa')
    expect(l[2]).toBe('▸ shell cat x.txt system.log a.md && cd .')
    expect(l[3]).toBe('▸ write .')
    expect(l.join('\n')).not.toMatch(/\/Users|\/var/)
  })
  it('urls keep their slashes', () => {
    expect(lines([tool('shell', '{"command":"curl https://example.com/a/b"}')])).toEqual(['▸ shell curl https://example.com/a/b'])
  })
  it('cwd comes from session.created when not given', () => {
    const created = { seq: ++seq, ts: 1, type: 'session.created', sessionId: 's1', payload: { cwd: '/h/u/p' } } as KernelEvent
    expect(lines([created, tool('read', '{"path":"/h/u/p/a.ts"}')])).toEqual(['▸ read a.ts'])
  })
  it('a failed call shows only the name', () => {
    expect(lines([tool('shell', '{"command":"rm x"}', 'c'), ev('tool.ended', { callId: 'c', name: 'shell', ok: false, ms: 1, content: 'boom sk-' + X(24) })])).toEqual(['✗ shell'])
  })
  it('keeps the last 5 with a count of the rest', () => {
    const evs = Array.from({ length: 8 }, (_, i) => tool('read', JSON.stringify({ path: `f${i}.ts` }), `c${i}`))
    expect(lines(evs)).toEqual(['…还有 3 个', '▸ read f3.ts', '▸ read f4.ts', '▸ read f5.ts', '▸ read f6.ts', '▸ read f7.ts'])
  })
})

describe('renderTurn: delegated runs', () => {
  const run = (kind: string, p: object = {}) => ev(kind, { runId: 'r1', executor: 'codex', ...p })
  const one = (evs: KernelEvent[], o = {}) => all(render(evs, o))
  it('queued → started → progress → ended in place', () => {
    const q = run('executor.run.queued', { callId: 'c' })
    const s = run('executor.run.started', { cwd: '/h/u/wt', worktree: '/h/u/wt' })
    const p = run('executor.run.progress', { kind: 'tool', text: 'edit /h/u/wt/src/a.ts ' + 'z'.repeat(100) })
    const e = run('executor.run.ended', { status: 'ok', changed: { files: ['a', 'b', 'c'], source: 'git' } })
    expect(one([q])).toBe('⧗ codex 排队中')
    expect(one([q, s])).toBe('⧗ codex 运行中')
    expect(one([q, s, p])).toMatch(/^⧗ codex 运行中 · edit src\/a\.ts z+…?$/)
    expect(one([q, s, p]).split(' · ')[1]!.length).toBeLessThanOrEqual(61)
    expect(one([q, s, p, e])).toBe('✓ codex 完成,改了 3 个文件')
    expect(one([q, s, p, e]).split('\n').length).toBe(1)
  })
  it('text and think progress never appear', () => {
    const q = run('executor.run.queued')
    const out = one([q, run('executor.run.progress', { kind: 'text', text: 'SECRETTEXT' }), run('executor.run.progress', { kind: 'think', text: 'SECRETTHINK' })])
    expect(out).toBe('⧗ codex 排队中')
  })
  it('failure shows a reason code, never a message', () => {
    const q = run('executor.run.queued')
    expect(one([q, run('executor.run.ended', { status: 'timeout' })])).toBe('✗ codex 失败(timeout)')
    expect(one([q, run('executor.run.ended', { status: 'failed', reason: 'quota' })])).toBe('✗ codex 失败(quota)')
    expect(one([q, run('executor.run.ended', { status: 'failed', reason: 'Bad Reason!', message: 'https://u:p@h' })])).toBe('✗ codex 失败(error)')
  })
  it('progress paths and secrets are cleaned, no absolute path in any run line', () => {
    const q = run('executor.run.queued')
    const out = one([q, run('executor.run.progress', { kind: 'file', text: '/Users/bob/proj/a.ts password=' + 'hunter' + mixed(10) })])
    expect(out).not.toMatch(/\/Users/)
    expect(out).not.toContain('hunter')
  })
  it('parked turn names the run', () => {
    const q = run('executor.run.queued')
    const out = one([q, run('executor.run.started'), ev('turn.parked', { active: 1, pending: 0 })])
    expect(out).toBe('⧗ codex 运行中\n等 codex 跑完,可以接着发消息')
    expect(one([q, run('executor.run.started'), ev('turn.parked', {}), ev('turn.resumed', {})])).toBe('⧗ codex 运行中')
  })
})

describe('renderTurn: ending', () => {
  it('reason mapping', () => {
    expect(all(render([ev('turn.failed', { reason: 'quota', message: 'secret acct' })]))).toBe('失败(quota)')
    expect(all(render([ev('turn.failed', { reason: 'Weird Reason\n!', message: 'x' })]))).toBe('失败(error)')
    expect(all(render([ev('turn.failed', { reason: 'a'.repeat(40) })]))).toBe('失败(error)')
    expect(all(render([ev('turn.failed', { reason: 'interrupted' })]))).toBe('后台重启,这轮中断了')
    expect(all(render([ev('turn.failed', {})]))).toBe('失败(error)')
  })
  it('other turns events are ignored', () => {
    const other = { seq: ++seq, ts: 1, type: 'message.assistant', sessionId: 's1', payload: { turnId: 'other', text: 'nope' } } as KernelEvent
    expect(render([other, ev('message.assistant', { text: 'mine' })]).map(c => c.text)).toEqual(['mine'])
  })
})
