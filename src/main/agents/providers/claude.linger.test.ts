import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import { BG_GRACE_MS } from './claudeBackground'
import { CHAT_STALL_KILL_MS } from '../idleWatchdog'
import type { AgentSession, ChatBackgroundHooks, ChatCallbacks } from '../types'

// 用户 2026-10-30:主代理开了三路后台调研、最后给一张 A/B/C 选项表就输出 result —— 界面一直「运行中」,
// 用户打的字只能排队;手动停止后排队的消息发出去,回来的是「claude 无输出 (退出码 143)」,只能再发一遍。
// 真 claude 2.1.312 实测:--resume 一个带着后台任务被杀的会话,它先重放 task_notification(stopped),
// 再为这条通知空跑一轮吐一个空 result(num_turns 0),然后才处理我们写进去的用户消息。
let dir: string
const lives: AgentSession[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-linger-')) })
afterEach(async () => {
  vi.useRealTimers()
  for (const l of lives.splice(0)) { try { l.cancel() } catch { /* already gone */ } }
  await sleep(150)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const S = 'sess-linger'
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, session_id: S, ...extra })
const textDelta = (text: string) => ({ type: 'stream_event', session_id: S, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const result = (r: string, numTurns = 1) => ({ type: 'result', subtype: 'success', is_error: false, result: r, num_turns: numTurns, session_id: S })

/**
 * 假 claude:每收到一条用户消息就按 script 吐事件(`$MSG` 换成消息原文),吐完挂着 stdin 不退出。
 * 启动时把 pid 记到 <tag>.pid,退出时写 <tag>.exit,好断言「是不是一个新进程」「旧进程有没有被收掉」。
 */
function fakeBin(tag: string, opts: { onStart?: object[]; perMessage: Array<{ at: number; obj: object }> }): string {
  const cli = join(dir, `${tag}.js`)
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs')
fs.writeFileSync(${JSON.stringify(join(dir, tag + '.pid'))}, String(process.pid))
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const bye = () => { try { fs.writeFileSync(${JSON.stringify(join(dir, tag + '.exit'))}, 'x') } catch {} ; process.exit(143) }
process.on('SIGTERM', bye)
for (const o of ${JSON.stringify(opts.onStart ?? [])}) out(o)
const steps = ${JSON.stringify(opts.perMessage)}
let buf = ''
process.stdin.on('data', (b) => {
  buf += b
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    const msg = typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content)
    for (const s of steps) setTimeout(() => out(JSON.parse(JSON.stringify(s.obj).split('$MSG').join(JSON.stringify(msg).slice(1, -1)))), s.at)
  }
})
setInterval(() => {}, 1000)
`)
  chmodSync(cli, 0o755)
  return cli
}

const settle = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'HANG'>(r => setTimeout(() => r('HANG'), ms))])
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function collect() {
  const st = { text: '', errors: [] as string[], doneAt: 0, statuses: [] as string[] }
  const t0 = Date.now()
  const cb: ChatCallbacks = {
    onSession: () => {}, onAssistantDelta: (t) => { st.text += t }, onThinkDelta: () => {},
    onStatus: (s) => st.statuses.push(s),
    onDone: () => { st.doneAt = Date.now() - t0 }, onError: (e) => st.errors.push(e.message),
  }
  return { st, cb }
}

// 主代理开一个后台任务(永远不结束,像 Monitor / 常驻命令),给一张选项表,然后 result。
const lingeringTurn = [
  { at: 0, obj: sys('init') }, { at: 0, obj: sys('status', { status: 'requesting' }) },
  { at: 10, obj: sys('background_tasks_changed', { tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'watch' }] }) },
  { at: 10, obj: sys('task_started', { task_id: 'b1', tool_use_id: 'tb1', is_backgrounded: true, task_type: 'local_bash' }) },
  { at: 20, obj: textDelta('| A | B | C |') },
  { at: 30, obj: result('| A | B | C |') },
]

describe('claude chat() — 停止之后立刻发新消息', () => {
  it('★不报「claude 无输出 (退出码 143)」,新消息由新进程真正处理', async () => {
    // 第一轮:后台任务在跑、还没到 result,用户点停止。
    const provider1 = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin('q1', { perMessage: lingeringTurn.slice(0, 5) })], defaultModels: [] })
    const a = collect()
    const s1 = provider1.chat!({ id: 'm1', prompt: 'x', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s1)
    await sleep(400)
    s1.cancel()
    expect(await settle(s1.done, 30_000)).not.toBe('HANG')
    expect(existsSync(join(dir, 'q1.exit'))).toBe(true)
    const pid1 = readFileSync(join(dir, 'q1.pid'), 'utf8')

    // 紧接着的新消息:--resume 起来的 claude 先重放 stopped 通知、空跑一轮吐空 result,然后才回答。
    const provider2 = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin('q2', { perMessage: [
      { at: 0, obj: sys('task_notification', { task_id: 'b1', tool_use_id: 'tb1', status: 'stopped', summary: 'watch' }) },
      { at: 5, obj: sys('init') },
      { at: 10, obj: result('', 0) },
      { at: 300, obj: sys('init') }, { at: 300, obj: sys('status', { status: 'requesting' }) },
      { at: 320, obj: textDelta('GOT:$MSG') },
      { at: 340, obj: result('GOT') },
    ] })], defaultModels: [] })
    const b = collect()
    const s2 = provider2.chat!({ id: 'm2', prompt: '新消息', model: 'opus-4.8', cwd: dir, sessionId: S }, b.cb, process.env)
    lives.push(s2)
    const r2 = await settle(s2.done, 10_000)
    expect(r2).not.toBe('HANG')
    expect((r2 as { ok: boolean }).ok).toBe(true)
    // 修之前:第一个空 result 就收尾杀进程 → 「claude 无输出 (退出码 143)」,消息丢了
    expect(b.st.errors).toEqual([])
    expect(b.st.text).toContain('新消息')
    expect(readFileSync(join(dir, 'q2.pid'), 'utf8')).not.toBe(pid1)
  })

  it('真正什么都没做的空 result(没有重放通知)照旧收尾,不会挂住', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin('r1', { perMessage: [
      { at: 0, obj: sys('init') }, { at: 10, obj: result('', 0) },
    ] })], defaultModels: [] })
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'x', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s)
    expect(await settle(s.done, 30_000)).not.toBe('HANG')
  })
})

// ── 下面的事件序列按真 claude 2.1.312 实录裁剪(haiku,临时目录,后台 Bash sleep 20):
//  result #1 之后写第二条消息 → init / requesting / 回复 / result,后台任务不受影响;任务结束 →
//  task_updated / task_notification / background_tasks_changed [] → ~0.2s 后 init / requesting / 回复 /
//  result(带 origin.kind = task-notification)。--input-format stream-json 下写用户消息永远不杀任务。
const origin = { origin: { kind: 'task-notification', producer: 'session-task', runId: 'r1' } }
const taskDone = (at: number): Step[] => [
  { at, obj: sys('task_updated', { task_id: 'b1', patch: { status: 'completed' } }) },
  { at, obj: sys('task_notification', { task_id: 'b1', tool_use_id: 'tb1', status: 'completed', summary: 'done' }) },
  { at, obj: sys('background_tasks_changed', { tasks: [] }) },
]
const autoTurn = (at: number, text: string, delay = 20): Step[] => [
  { at, obj: sys('init') }, { at, obj: sys('status', { status: 'requesting' }) },
  { at: at + delay, obj: textDelta(text) },
  { at: at + delay + 20, obj: { ...result(text), ...origin } },
]
type Step = { at: number; obj: object }
const replyTurn = (text: string): Step[] => [
  { at: 0, obj: sys('init') }, { at: 0, obj: sys('status', { status: 'requesting' }) },
  { at: 20, obj: textDelta(text) },
  { at: 30, obj: result(text) },
]

/**
 * 假 claude(第 n 条用户消息吐 script[n])。记下一切可断言的:每次 spawn 的 argv、收到的每一行 stdin。
 * 控制请求按 ctl 回答,默认成功。bin 直接用它就能走真实的 buildClaudeChatArgs 分支。
 */
function scripted(tag: string, script: Step[][], ctl: Record<string, string> = {}): string {
  const cli = join(dir, `${tag}.js`)
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs')
const base = ${JSON.stringify(join(dir, tag))}
fs.appendFileSync(base + '.spawns', JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n')
const log = (s) => fs.appendFileSync(base + '.log', s + '\\n')
const out = (o) => { log('out ' + (o.type === 'result' ? 'result' : o.subtype ?? o.type)); process.stdout.write(JSON.stringify(o) + '\\n') }
process.on('SIGTERM', () => { fs.writeFileSync(base + '.exit', 'x'); process.exit(143) })
const script = ${JSON.stringify(script)}
const ctl = ${JSON.stringify(ctl)}
let n = 0, buf = ''
process.stdin.on('data', (b) => {
  buf += b
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type === 'control_request') {
      const st = m.request.subtype
      if (st === 'initialize') continue
      log('ctl ' + st + ' ' + (m.request.model ?? m.request.mode))
      const key = st + ':' + (m.request.model ?? m.request.mode)
      process.stdout.write(JSON.stringify({ type: 'control_response', response: ctl[key]
        ? { subtype: 'error', request_id: m.request_id, error: ctl[key] }
        : { subtype: 'success', request_id: m.request_id, response: {} } }) + '\\n')
      continue
    }
    if (m.type === 'control_response') { log('answer ' + m.response.response?.behavior); continue }
    if (m.type !== 'user') continue
    log('user ' + m.message.content[0].text)
    for (const s of script[n++] ?? []) setTimeout(() => out(s.obj), s.at)
  }
})
setInterval(() => {}, 1000)
`)
  chmodSync(cli, 0o755)
  return cli
}
const spawns = (tag: string) => readFileSync(join(dir, `${tag}.spawns`), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { pid: number; argv: string[] })
const logLines = (tag: string) => readFileSync(join(dir, `${tag}.log`), 'utf8').trim().split('\n')
const exitedProc = (tag: string) => existsSync(join(dir, `${tag}.exit`))

/** background 钩子,记录任务数和停止入口;follow-up 接到 collect() 上。 */
function hooks() {
  const counts: number[] = []
  const follow = collect()
  const st = { opened: 0, stop: null as null | (() => void), session: null as AgentSession | null }
  const h: ChatBackgroundHooks = {
    onRunning: (n, stop) => { counts.push(n); st.stop = stop },
    openTurn: (attach) => { st.opened++; st.session = attach(follow.cb) },
  }
  return { h, counts, follow, st }
}
const until = async (cond: () => boolean, ms = 30_000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('until: timed out'); await sleep(20) } }
const task = (over: object = {}) => ({ id: 'm', prompt: 'x', model: 'opus-4.8', cwd: dir, ...over })

describe('claude chat() — 下一条消息接到活进程上', () => {
  it('★写进同一个进程:不杀、不 --resume,后台任务活着,回复归这一轮', async () => {
    const provider = makeClaudeProvider({ bin: scripted('a', [lingeringTurn, replyTurn('SECOND')]), defaultModels: [] })
    const bgh = hooks(), one = collect(), two = collect()
    const s1 = provider.chat!(task({ background: bgh.h }), one.cb, process.env)
    lives.push(s1)
    expect(await settle(s1.done, 30_000)).toMatchObject({ ok: true })
    expect(one.st.doneAt).toBeGreaterThan(0)     // 输入框放开了:result 一到这一轮就收尾
    const s2 = provider.chat!(task({ id: 'm2', prompt: '选 B', sessionId: S, background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 30_000)).toMatchObject({ ok: true })
    expect(two.st.text).toBe('SECOND')
    expect(one.st.text).toBe('| A | B | C |')
    expect(two.st.errors).toEqual([])
    expect(spawns('a')).toHaveLength(1)
    expect(spawns('a')[0].argv).not.toContain('--resume')
    expect(exitedProc('a')).toBe(false)
    expect(logLines('a').filter(l => l.startsWith('user '))).toEqual(['user x', 'user 选 B'])
    expect(bgh.counts).toEqual([1])              // 整个过程任务数没掉过
  })

  it('旧一轮的句柄再 cancel 不杀进程(里面是新的一轮和后台任务)', async () => {
    const provider = makeClaudeProvider({ bin: scripted('b', [lingeringTurn, replyTurn('SECOND')]), defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    await settle(s1.done, 30_000)
    const s2 = provider.chat!(task({ id: 'm2', sessionId: S, background: bgh.h }), collect().cb, process.env)
    lives.push(s2)
    await settle(s2.done, 30_000)
    s1.cancel()
    await sleep(200)
    expect(exitedProc('b')).toBe(false)
  })

  it('★CLI 自己那一轮还没开口时来了用户消息:压到它的 result 之后才写,不被吸进那一轮', async () => {
    const script = [[...lingeringTurn, ...taskDone(300), ...autoTurn(310, 'FOLLOW', 500)], replyTurn('SECOND')]
    const provider = makeClaudeProvider({ bin: scripted('c', script), defaultModels: [] })
    const bgh = hooks(), two = collect()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    await until(() => logLines('c').filter(l => l === 'out init').length === 2)
    const s2 = provider.chat!(task({ id: 'm2', prompt: '第二条', sessionId: S, background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 30_000)).toMatchObject({ ok: true })
    const log = logLines('c')
    expect(log.indexOf('user 第二条')).toBeGreaterThan(log.indexOf('out result', log.indexOf('out init', log.indexOf('out init') + 1)))
    expect(two.st.text).toBe('FOLLOW\n\nSECOND')
    expect(bgh.st.opened).toBe(0)                // 那段话进了这条回复,没有另开一条
    expect(spawns('c')).toHaveLength(1)
  })
})

describe('claude chat() — 后台任务完成后 CLI 自己起的一轮', () => {
  it('★回复开一条新消息送到;那一轮没后台活了才回收进程', async () => {
    const script = [[...lingeringTurn, ...taskDone(200), ...autoTurn(210, '后台跑完了')]]
    const provider = makeClaudeProvider({ bin: scripted('d', script), defaultModels: [] })
    const bgh = hooks(), one = collect()
    const s1 = provider.chat!(task({ background: bgh.h }), one.cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    await until(() => bgh.st.opened === 1)
    expect(await settle(bgh.st.session!.done, 30_000)).toMatchObject({ ok: true })
    expect(bgh.follow.st.text).toBe('后台跑完了')
    expect(bgh.follow.st.doneAt).toBeGreaterThan(0)
    expect(bgh.follow.st.errors).toEqual([])
    expect(one.st.text).toBe('| A | B | C |')    // 没混进上一条
    expect(bgh.counts).toEqual([1, 0])
    await until(() => exitedProc('d'))
  })

  it('什么都没说的一轮不开空消息', async () => {
    const script = [[...lingeringTurn, ...taskDone(200), { at: 210, obj: sys('init') }, { at: 210, obj: sys('status', { status: 'requesting' }) }, { at: 220, obj: result('', 0) }]]
    const provider = makeClaudeProvider({ bin: scripted('e', script), defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    await until(() => exitedProc('e'))
    expect(bgh.st.opened).toBe(0)
  })

  it('开消息要排队(泳道被别的一轮占着):事件攒着,接上时一条不少', async () => {
    const script = [[...lingeringTurn, ...taskDone(100), ...autoTurn(110, '晚到的回复')]]
    const provider = makeClaudeProvider({ bin: scripted('f', script), defaultModels: [] })
    let attach: Parameters<ChatBackgroundHooks['openTurn']>[0] | null = null
    const s1 = provider.chat!(task({ background: { onRunning: () => {}, openTurn: (a: NonNullable<typeof attach>) => { attach = a } } }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    await until(() => attach !== null)
    await sleep(300)                              // result 已经到了,还没人接
    const late = collect()
    const s = attach!(late.cb)
    expect(await settle(s.done, 30_000)).toMatchObject({ ok: true })
    expect(late.st.text).toBe('晚到的回复')
  })

  it('没有这一轮时后台子代理要权限:走 background 的门,答案回给 CLI', async () => {
    const gate = { type: 'control_request', request_id: 'g1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't9', agent_id: 'sub1' } }
    const provider = makeClaudeProvider({ bin: scripted('g', [[...lingeringTurn, { at: 100, obj: gate }]]), defaultModels: [] })
    const confirm = vi.fn(async () => 'allow' as const)
    const s1 = provider.chat!(task({ background: { onRunning: () => {}, openTurn: () => {}, onConfirm: confirm } }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    await until(() => logLines('g').includes('answer allow'))
    expect(confirm).toHaveBeenCalledOnce()
  })
})

describe('claude chat() — 回收与停止', () => {
  const waitIo = async (cond: () => boolean) => { const t = Date.now(); while (!cond() && Date.now() - t < 30_000) await new Promise(r => setImmediate(r)) }
  const realSleep = async (ms: number) => { const t = Date.now(); while (Date.now() - t < ms) await new Promise(r => setImmediate(r)) }
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  it('★后台任务在跑:过了 30 分钟(再乘三)也不杀,之后的消息照样接上', async () => {
    const provider = makeClaudeProvider({ bin: scripted('h', [lingeringTurn, replyTurn('LATER')]), defaultModels: [] })
    fakeClock()
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    lives.push(s1)
    let settled = false
    void s1.done.then(() => { settled = true })
    await waitIo(() => settled)
    expect(settled).toBe(true)
    await vi.advanceTimersByTimeAsync(CHAT_STALL_KILL_MS * 3)
    await realSleep(100)
    expect(exitedProc('h')).toBe(false)
    expect(bgh.counts).toEqual([1])
    const two = collect()
    const s2 = provider.chat!(task({ id: 'm2', sessionId: S, background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    await waitIo(() => two.st.doneAt > 0)
    expect(two.st.text).toBe('LATER')
    expect(spawns('h')).toHaveLength(1)
  })

  it('没人看得见的调用方(没给 background):30 分钟上限还在', async () => {
    const provider = makeClaudeProvider({ bin: scripted('i', [lingeringTurn]), defaultModels: [] })
    fakeClock()
    const s1 = provider.chat!(task(), collect().cb, process.env)
    lives.push(s1)
    let settled = false
    void s1.done.then(() => { settled = true })
    await waitIo(() => settled)
    await vi.advanceTimersByTimeAsync(CHAT_STALL_KILL_MS + 1)
    await waitIo(() => exitedProc('i'))
    expect(exitedProc('i')).toBe(true)
  })

  it('★任务都结束了、也没有新一轮:宽限期后回收,不留空转进程', async () => {
    const provider = makeClaudeProvider({ bin: scripted('j', [[...lingeringTurn, ...taskDone(100)]]), defaultModels: [] })
    fakeClock()
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    lives.push(s1)
    await waitIo(() => bgh.counts.includes(0))
    expect(bgh.counts).toEqual([1, 0])
    await realSleep(50)
    expect(exitedProc('j')).toBe(false)
    await vi.advanceTimersByTimeAsync(BG_GRACE_MS + 1)
    await waitIo(() => exitedProc('j'))
    expect(exitedProc('j')).toBe(true)
  })

  it('这一轮真卡死(30 分钟没输出)但后台在跑:只收尾这一轮,不杀后台', async () => {
    const stuck = lingeringTurn.slice(0, 5)        // 有后台任务,一直没有 result
    const provider = makeClaudeProvider({ bin: scripted('k', [stuck]), defaultModels: [] })
    fakeClock()
    const bgh = hooks(), one = collect()
    const s1 = provider.chat!(task({ background: bgh.h }), one.cb, process.env)
    lives.push(s1)
    await waitIo(() => bgh.counts.includes(1))
    await realSleep(100)
    await vi.advanceTimersByTimeAsync(240_000 + CHAT_STALL_KILL_MS + 1)
    await waitIo(() => one.st.doneAt > 0)
    expect(one.st.doneAt).toBeGreaterThan(0)
    expect(exitedProc('k')).toBe(false)
  })

  it('★明确停止:杀整棵树;下一条消息起新进程 --resume,吃掉重放的空 result 不报 143', async () => {
    const replay: Step[] = [
      { at: 0, obj: sys('task_notification', { task_id: 'b1', tool_use_id: 'tb1', status: 'stopped', summary: 'watch' }) },
      { at: 5, obj: sys('init') },
      { at: 10, obj: result('', 0) },
      { at: 50, obj: sys('init') }, { at: 50, obj: sys('status', { status: 'requesting' }) },
      { at: 60, obj: textDelta('GOT') },
      { at: 70, obj: result('GOT') },
    ]
    const bin = scripted('l', [lingeringTurn])
    const provider = makeClaudeProvider({ bin, defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    await settle(s1.done, 30_000)
    expect(bgh.st.stop).toBeTypeOf('function')
    bgh.st.stop!()
    expect(bgh.counts).toEqual([1, 0])            // 那个停止的控件马上消失
    // 紧接着发:旧进程还没退也不能接消息,等它退了再 --resume。
    writeFileSync(bin, readFileSync(bin, 'utf8').replace('const script = ', `const script = ${JSON.stringify([replay])} || `))
    const two = collect()
    const s2 = provider.chat!(task({ id: 'm2', prompt: '新消息', sessionId: S, background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 10_000)).toMatchObject({ ok: true })
    expect(exitedProc('l')).toBe(true)
    expect(two.st.errors).toEqual([])
    expect(two.st.text).toBe('GOT')
    expect(spawns('l')).toHaveLength(2)
    expect(spawns('l')[1].argv.slice(-2)).toEqual(['--resume', S])
  })
})

describe('claude chat() — 下一条消息带着不一样的参数', () => {
  it('★模型 / 权限档:走控制协议现场改,后台不动,进程不换', async () => {
    const provider = makeClaudeProvider({ bin: scripted('m', [lingeringTurn, replyTurn('OK')]), defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h, permissionMode: 'auto' }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    const two = collect()
    const s2 = provider.chat!(task({ id: 'm2', prompt: '第二条', sessionId: S, model: 'sonnet-4.6', permissionMode: 'readonly', background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 30_000)).toMatchObject({ ok: true })
    expect(two.st.text).toBe('OK')
    const log = logLines('m')
    expect(log).toContain('ctl set_model sonnet')
    expect(log).toContain('ctl set_permission_mode plan')
    // 必须先切好再写消息:只读这件事不能晚一拍。
    expect(log.indexOf('user 第二条')).toBeGreaterThan(log.indexOf('ctl set_permission_mode plan'))
    expect(log.indexOf('user 第二条')).toBeGreaterThan(log.indexOf('ctl set_model sonnet'))
    expect(spawns('m')).toHaveLength(1)
    expect(exitedProc('m')).toBe(false)
  })

  it('★切只读失败:这条消息不发,这一轮报错,后台任务不动', async () => {
    const provider = makeClaudeProvider({ bin: scripted('n', [lingeringTurn], { 'set_permission_mode:plan': 'nope' }), defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    const two = collect()
    const s2 = provider.chat!(task({ id: 'm2', prompt: '改文件', sessionId: S, permissionMode: 'readonly', background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 30_000)).toMatchObject({ ok: false })
    expect(two.st.errors.join()).toContain('只读')
    expect(logLines('n')).not.toContain('user 改文件')
    expect(exitedProc('n')).toBe(false)
  })

  it('切「完全访问」被拒(没带 bypass 启动)是预期:消息照发,门由上层按会话档放行', async () => {
    const provider = makeClaudeProvider({ bin: scripted('o', [lingeringTurn, replyTurn('OK')], { 'set_permission_mode:bypassPermissions': 'bypass_not_launched' }), defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    const two = collect()
    const s2 = provider.chat!(task({ id: 'm2', sessionId: S, permissionMode: 'full', background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 30_000)).toMatchObject({ ok: true })
    expect(two.st.text).toBe('OK')
    expect(two.st.errors).toEqual([])
  })

  it('★浏览器开关变了(只能 spawn 时定)且后台在跑:不杀,沿用活进程,说一声;关掉的浏览器工具门直接拒', async () => {
    const browserGate = { type: 'control_request', request_id: 'g2', request: { subtype: 'can_use_tool', tool_name: 'mcp__claude-in-chrome__navigate', input: {}, tool_use_id: 't2' } }
    const provider = makeClaudeProvider({ bin: scripted('p', [lingeringTurn, [{ at: 0, obj: browserGate }, ...replyTurn('OK').map(s => ({ ...s, at: s.at + 50 }))]]), defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h, browserUse: 'allow' }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    const two = collect()
    const confirm = vi.fn(async () => 'allow' as const)
    two.cb.onConfirm = confirm
    const s2 = provider.chat!(task({ id: 'm2', sessionId: S, browserUse: 'off', background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 30_000)).toMatchObject({ ok: true })
    expect(spawns('p')).toHaveLength(1)
    expect(exitedProc('p')).toBe(false)
    expect(two.st.statuses.join()).toContain('浏览器开关')
    expect(confirm).not.toHaveBeenCalled()
    expect(logLines('p')).toContain('answer deny')
  })

  it('浏览器开关变了但后台已经没活:收掉再 --resume,新参数当场生效', async () => {
    const bin = scripted('q', [[...lingeringTurn, ...taskDone(100)], replyTurn('OK')])
    const provider = makeClaudeProvider({ bin, defaultModels: [] })
    const bgh = hooks()
    const s1 = provider.chat!(task({ background: bgh.h, browserUse: 'off' }), collect().cb, process.env)
    lives.push(s1)
    await settle(s1.done, 30_000)
    await until(() => bgh.counts.includes(0))
    writeFileSync(bin, readFileSync(bin, 'utf8').replace('const script = ', `const script = ${JSON.stringify([replyTurn('OK')])} || `))
    const two = collect()
    const s2 = provider.chat!(task({ id: 'm2', sessionId: S, browserUse: 'allow', background: bgh.h }), two.cb, process.env)
    lives.push(s2)
    expect(await settle(s2.done, 10_000)).toMatchObject({ ok: true })
    expect(two.st.text).toBe('OK')
    expect(exitedProc('q')).toBe(true)
    expect(spawns('q')).toHaveLength(2)
    expect(spawns('q')[1].argv).toContain('--chrome')
    expect(spawns('q')[1].argv.slice(-2)).toEqual(['--resume', S])
  })
})
