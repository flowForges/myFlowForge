import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import { INTERJECT_SETTLE_MS } from './claudeBackground'
import type { AgentSession, ChatBackgroundHooks, ChatCallbacks } from '../types'

// 插话:一轮还在跑时,把排队的那条作为 user 消息写进同一个进程的 stdin(和正常发送同一个构造)。
// ★★这一轮已经出了 result → false(调用方放回队列,下一轮再发)。
// ★★写进去了、但 CLI 在吸收之前就收了尾(result 已经在管道里):它会为这条消息自己再起一轮 ——
//   不能一见 result 就杀进程,否则这条消息两头都没有(既没进旧轮,也不在队列里)。
let dir: string
const lives: AgentSession[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-interject-')) })
afterEach(async () => {
  for (const l of lives.splice(0)) { try { l.cancel() } catch { /* already gone */ } }
  await sleep(150)
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const S = 'sess-interject'
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, session_id: S, ...extra })
const textDelta = (text: string) => ({ type: 'stream_event', session_id: S, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const result = (r: string) => ({ type: 'result', subtype: 'success', is_error: false, result: r, num_turns: 1, session_id: S })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<'HANG'>(r => setTimeout(() => r('HANG'), ms))])

/** 假 claude:第 n 条用户消息按 scripts[n] 吐事件($MSG 换成原文);每条 stdin 行记到 stdin.log。 */
function fakeBin(scripts: Array<Array<{ at: number; obj: object }>>): string {
  const cli = join(dir, 'fake.js')
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs')
const log = ${JSON.stringify(join(dir, 'stdin.log'))}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(join(dir, 'exit'))}, 'x'); process.exit(143) })
const scripts = ${JSON.stringify(scripts)}
// ★消息序号跨进程累计:进程被回收、下一条 --resume 新起一个时,接着按 scripts 往下走
const nFile = ${JSON.stringify(join(dir, 'n'))}
let n = fs.existsSync(nFile) ? Number(fs.readFileSync(nFile, 'utf8')) : 0, buf = ''
process.stdin.on('data', (b) => {
  buf += b
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    fs.appendFileSync(log, line + '\\n')
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
    fs.writeFileSync(nFile, String(n + 1))
    const msg = m.message.content.map(c => c.text).join('')
    for (const s of scripts[n++] ?? []) setTimeout(() => out(JSON.parse(JSON.stringify(s.obj).split('$MSG').join(JSON.stringify(msg).slice(1, -1)))), s.at)
  }
})
setInterval(() => {}, 1000)
`)
  chmodSync(cli, 0o755)
  return cli
}

function collect() {
  const st = { text: '', errors: [] as string[], done: false }
  const cb: ChatCallbacks = {
    onSession: () => {}, onAssistantDelta: (t) => { st.text += t }, onThinkDelta: () => {},
    onDone: () => { st.done = true }, onError: (e) => st.errors.push(e.message),
  }
  return { st, cb }
}
const userLines = () => existsSync(join(dir, 'stdin.log'))
  ? readFileSync(join(dir, 'stdin.log'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.type === 'user')
  : []
const waitFor = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await sleep(10) ; return cond() }

describe('claude chat() — 插话', () => {
  it('一轮在跑:写进同一个进程的 stdin,回复归这一轮;result 之后再插话 → false', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([[
      { at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 300, obj: result('A') },
    ], []])], defaultModels: [] })
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s)
    expect(typeof s.interject).toBe('function')
    await waitFor(() => a.st.text === 'A')
    expect(await s.interject!('second', [{ name: 'f.txt', path: '/tmp/f.txt', size: 1 }])).toBe(true)
    expect(await waitFor(() => userLines().length === 2)).toBe(true)
    const injected = userLines()[1]
    // 和正常发送同一个构造:同一种 user 行,附件按 buildChatPrompt 拼在正文后面
    expect(injected.message.content[0].text).toBe('second\n\n附件:\n- /tmp/f.txt')
    expect(injected.parent_tool_use_id).toBeNull()
    expect(await settle(s.done, 3000)).toMatchObject({ ok: true })
    expect(a.st.done).toBe(true)
    expect(await s.interject!('late')).toBe(false)
    expect(userLines().length).toBe(2)
  })

  it('★写进去时 CLI 已经收尾、随即为它单起一轮:那一轮接在这一轮回复后面,它的 result 才收尾', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      // 第二条(插话)没被这一轮吸收:result 之后 CLI 为它单起一轮
      [{ at: 300, obj: sys('init') }, { at: 300, obj: sys('status', { status: 'requesting' }) }, { at: 320, obj: textDelta('re:$MSG') }, { at: 340, obj: result('re') }],
    ])], defaultModels: [] })
    const a = collect()
    let opened = 0
    const background: ChatBackgroundHooks = { onRunning: () => {}, openTurn: () => { opened++ } }
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir, background }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    expect(await s.interject!('second')).toBe(true)
    expect(await settle(s.done, 3000)).toMatchObject({ ok: true })
    expect(a.st.text).toBe('A\n\nre:second')
    expect(opened).toBe(0)
    expect(a.st.errors).toEqual([])
  })

  it('★CLI 很晚才为插话单起一轮(这一轮已收尾、没有下一条):进程没被杀,回复以 CLI 自己那一轮回来', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      [{ at: INTERJECT_SETTLE_MS + 600, obj: sys('init') }, { at: INTERJECT_SETTLE_MS + 600, obj: sys('status', { status: 'requesting' }) }, { at: INTERJECT_SETTLE_MS + 620, obj: textDelta('re:$MSG') }, { at: INTERJECT_SETTLE_MS + 640, obj: result('re') }],
    ])], defaultModels: [] })
    const a = collect()
    const adopted = collect()
    let opened = 0
    const background: ChatBackgroundHooks = {
      onRunning: () => {},
      openTurn: (attach, isCurrent) => { opened++; if (isCurrent()) lives.push(attach(adopted.cb)) },
    }
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir, background }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    expect(await s.interject!('second')).toBe(true)
    expect(await settle(s.done, 4000)).toMatchObject({ ok: true })
    expect(a.st.text).toBe('A')
    expect(await waitFor(() => adopted.st.done, 4000)).toBe(true)
    expect(opened).toBe(1)
    expect(adopted.st.text).toBe('re:second')
  })

  it('★插话已被吸收(CLI 不再起新一轮)、下一条 C 接上来:C 压一会儿后照样写出、由 C 回答', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      [],
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('re:$MSG') }, { at: 30, obj: result('re') }],
    ])], defaultModels: [] })
    const background: ChatBackgroundHooks = { onRunning: () => {}, openTurn: () => {} }
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir, background }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    expect(await s.interject!('second')).toBe(true)
    expect(await settle(s.done, 4000)).toMatchObject({ ok: true })
    const c = collect()
    const sc = provider.chat!({ id: 'm3', prompt: 'third', model: 'opus-4.8', cwd: dir, sessionId: S, background }, c.cb, process.env)
    lives.push(sc)
    expect(await settle(sc.done, 4000)).toMatchObject({ ok: true })
    expect(c.st.text).toBe('re:third')
    expect(userLines().map(m => m.message.content[0].text)).toEqual(['first', 'second', 'third'])
  })

  it('★C 接上来之后 CLI 才为插话单起一轮:C 压到那一轮的 result 才写,C 不丢、只答一次', async () => {
    const late = INTERJECT_SETTLE_MS + 500
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      [{ at: late, obj: sys('init') }, { at: late, obj: sys('status', { status: 'requesting' }) }, { at: late + 20, obj: textDelta('re:$MSG') }, { at: late + 40, obj: result('re') }],
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('re:$MSG') }, { at: 30, obj: result('re') }],
    ])], defaultModels: [] })
    const background: ChatBackgroundHooks = { onRunning: () => {}, openTurn: () => {} }
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir, background }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    expect(await s.interject!('second')).toBe(true)
    expect(await settle(s.done, 4000)).toMatchObject({ ok: true })
    const c = collect()
    const sc = provider.chat!({ id: 'm3', prompt: 'third', model: 'opus-4.8', cwd: dir, sessionId: S, background }, c.cb, process.env)
    lives.push(sc)
    expect(await settle(sc.done, 5000)).toMatchObject({ ok: true })
    expect(c.st.text).toBe('re:second\n\nre:third')
    expect(c.st.errors).toEqual([])
    expect(userLines().map(m => m.message.content[0].text)).toEqual(['first', 'second', 'third'])
  })

  it('★插话被 CLI 单起一轮并入这一轮:那一轮的 result 一到就收尾(不再多等一个宽限期),进程照常回收', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      [{ at: 300, obj: sys('init') }, { at: 300, obj: sys('status', { status: 'requesting' }) }, { at: 320, obj: textDelta('re:$MSG') }, { at: 340, obj: result('re') }],
    ])], defaultModels: [] })
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    const t0 = Date.now()
    expect(await s.interject!('second')).toBe(true)
    expect(await settle(s.done, 4000)).toMatchObject({ ok: true })
    // 第二个 result 在 ~340ms;旧行为再等 INTERJECT_SETTLE_MS 才收尾
    expect(Date.now() - t0).toBeLessThan(340 + INTERJECT_SETTLE_MS - 500)
    expect(a.st.text).toBe('A\n\nre:second')
    expect(await waitFor(() => existsSync(join(dir, 'exit')), 1000)).toBe(true)
  })

  it('★插话并入这一轮之后下一条 C 接上来:C 立刻写出(不压 INTERJECT_SETTLE_MS),进程不停车', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      [{ at: 300, obj: sys('init') }, { at: 300, obj: sys('status', { status: 'requesting' }) }, { at: 320, obj: textDelta('re:$MSG') }, { at: 340, obj: result('re') }],
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('re:$MSG') }, { at: 30, obj: result('re') }],
    ])], defaultModels: [] })
    const background: ChatBackgroundHooks = { onRunning: () => {}, openTurn: () => {} }
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir, background }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    const t0 = Date.now()
    expect(await s.interject!('second')).toBe(true)
    expect(await settle(s.done, 4000)).toMatchObject({ ok: true })
    expect(Date.now() - t0).toBeLessThan(340 + INTERJECT_SETTLE_MS - 500)
    expect(a.st.text).toBe('A\n\nre:second')
    // 没有后台活:进程照常回收(不是停车等 15s)
    expect(await waitFor(() => existsSync(join(dir, 'exit')), 1000)).toBe(true)
    const c = collect()
    const t1 = Date.now()
    const sc = provider.chat!({ id: 'm3', prompt: 'third', model: 'opus-4.8', cwd: dir, sessionId: S, background }, c.cb, process.env)
    lives.push(sc)
    expect(await settle(sc.done, 4000)).toMatchObject({ ok: true })
    expect(Date.now() - t1).toBeLessThan(INTERJECT_SETTLE_MS - 500)
    expect(c.st.text).toBe('re:third')
  })

  it('★R8 一轮只接一条在途插话:上一条还没着落时第二条 → false(留在队列);上一条并进来之后再插 → 接受,一条不丢', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      [{ at: 300, obj: sys('init') }, { at: 300, obj: sys('status', { status: 'requesting' }) }, { at: 320, obj: textDelta('re:$MSG') }, { at: 900, obj: result('re') }],
      [{ at: 100, obj: sys('init') }, { at: 100, obj: sys('status', { status: 'requesting' }) }, { at: 120, obj: textDelta('re:$MSG') }, { at: 150, obj: result('re') }],
    ])], defaultModels: [] })
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s)
    await waitFor(() => a.st.text === 'A')
    expect(await s.interject!('second')).toBe(true)
    expect(await s.interject!('third')).toBe(false)          // 上一条还在途:不收,调用方放回队列
    expect(await waitFor(() => a.st.text.includes('re:second'))).toBe(true)
    expect(await s.interject!('third')).toBe(true)           // 上一条已经并进来了:可以再插
    expect(await settle(s.done, 5000)).toMatchObject({ ok: true })
    expect(a.st.text).toBe('A\n\nre:second\n\nre:third')
    expect(userLines().map(m => m.message.content[0].text)).toEqual(['first', 'second', 'third'])
  })

  it('没有插话时行为不变:result 一到就回收进程', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([[
      { at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 50, obj: result('A') },
    ]])], defaultModels: [] })
    const a = collect()
    const s = provider.chat!({ id: 'm1', prompt: 'first', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s)
    expect(await settle(s.done, 3000)).toMatchObject({ ok: true })
    expect(await waitFor(() => existsSync(join(dir, 'exit')))).toBe(true)
    expect(await s.interject!('late')).toBe(false)
  })
})
