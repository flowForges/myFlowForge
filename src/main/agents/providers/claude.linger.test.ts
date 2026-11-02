import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { AgentSession, ChatCallbacks } from '../types'

// 用户 2026-10-30:主代理开了三路后台调研、最后给一张 A/B/C 选项表就输出 result —— 界面一直「运行中」,
// 用户打的字只能排队;手动停止后排队的消息发出去,回来的是「claude 无输出 (退出码 143)」,只能再发一遍。
// 真 claude 2.1.312 实测:--resume 一个带着后台任务被杀的会话,它先重放 task_notification(stopped),
// 再为这条通知空跑一轮吐一个空 result(num_turns 0),然后才处理我们写进去的用户消息。
let dir: string
const lives: AgentSession[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-linger-')) })
afterEach(() => { for (const l of lives.splice(0)) { try { l.cancel() } catch { /* already gone */ } } rmSync(dir, { recursive: true, force: true }) })

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

describe('claude chat() — result 之后进程还挂着(后台任务没跑完)', () => {
  it('★result 一到这一轮就收尾;进程留在后台;下一条消息先收掉它、再由新进程处理', async () => {
    const provider1 = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin('p1', { perMessage: lingeringTurn })], defaultModels: [] })
    const a = collect()
    const s1 = provider1.chat!({ id: 'm1', prompt: 'x', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s1)
    const r1 = await settle(s1.done, 5_000)
    expect(r1).not.toBe('HANG')            // 修之前:停车等后台任务,这里一直挂着
    expect((r1 as { ok: boolean }).ok).toBe(true)
    expect(a.st.text).toBe('| A | B | C |')
    expect(a.st.errors).toEqual([])
    await sleep(300)
    expect(existsSync(join(dir, 'p1.exit'))).toBe(false)   // 后台任务还在跑,进程没被杀
    const pid1 = readFileSync(join(dir, 'p1.pid'), 'utf8')

    // 用户挑了 B。新进程(--resume)先重放旧进程的后台通知 + 空 result,再回答。
    const provider2 = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin('p2', { perMessage: [
      { at: 0, obj: sys('task_notification', { task_id: 'b1', tool_use_id: 'tb1', status: 'stopped', summary: 'watch' }) },
      { at: 5, obj: sys('init') },
      { at: 10, obj: result('', 0) },
      { at: 50, obj: sys('init') }, { at: 50, obj: sys('status', { status: 'requesting' }) },
      { at: 60, obj: textDelta('GOT:$MSG') },
      { at: 70, obj: result('GOT') },
    ] })], defaultModels: [] })
    const b = collect()
    const s2 = provider2.chat!({ id: 'm2', prompt: '选 B', model: 'opus-4.8', cwd: dir, sessionId: S }, b.cb, process.env)
    lives.push(s2)
    const r2 = await settle(s2.done, 10_000)
    expect(r2).not.toBe('HANG')
    expect((r2 as { ok: boolean }).ok).toBe(true)
    expect(existsSync(join(dir, 'p1.exit'))).toBe(true)    // 旧进程先被收掉
    expect(readFileSync(join(dir, 'p2.pid'), 'utf8')).not.toBe(pid1)
    expect(b.st.errors).toEqual([])
    expect(b.st.text).toContain('GOT:')
    expect(b.st.text).toContain('选 B')
  })
})

describe('claude chat() — 停止之后立刻发新消息', () => {
  it('★不报「claude 无输出 (退出码 143)」,新消息由新进程真正处理', async () => {
    // 第一轮:后台任务在跑、还没到 result,用户点停止。
    const provider1 = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin('q1', { perMessage: lingeringTurn.slice(0, 5) })], defaultModels: [] })
    const a = collect()
    const s1 = provider1.chat!({ id: 'm1', prompt: 'x', model: 'opus-4.8', cwd: dir }, a.cb, process.env)
    lives.push(s1)
    await sleep(400)
    s1.cancel()
    expect(await settle(s1.done, 5_000)).not.toBe('HANG')
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
    expect(await settle(s.done, 5_000)).not.toBe('HANG')
  })
})
