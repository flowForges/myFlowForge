import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
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
let n = 0, buf = ''
process.stdin.on('data', (b) => {
  buf += b
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    fs.appendFileSync(log, line + '\\n')
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type !== 'user') continue
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

  it('★写进去时 CLI 已经收尾:它为这条消息自己再起一轮 → 进程不能被杀,回复以 CLI 自己那一轮回来', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [fakeBin([
      [{ at: 0, obj: sys('init') }, { at: 10, obj: textDelta('A') }, { at: 100, obj: result('A') }],
      // 第二条(插话)没被这一轮吸收:result 之后 CLI 为它单起一轮
      [{ at: 300, obj: sys('init') }, { at: 300, obj: sys('status', { status: 'requesting' }) }, { at: 320, obj: textDelta('re:$MSG') }, { at: 340, obj: result('re') }],
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
    expect(await settle(s.done, 3000)).toMatchObject({ ok: true })
    expect(await waitFor(() => adopted.st.done)).toBe(true)
    expect(opened).toBe(1)
    expect(adopted.st.text).toBe('re:second')
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
