import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeClaudeProvider } from './claude'
import type { AgentSession } from '../types'

// 用户 2026-10-03 撞上:主代理用 Agent 工具开了两个**后台**子代理,说一句「还在跑」就输出 result,
// chat() 见 result 就 killTree,子代理跟着死;卡片还把「已启动」回执当成「已完成」。
// 下面的事件序列按真 claude 2.1.285 headless stream-json 的实录裁剪(见 claudeBackground.ts 顶部)。
let dir: string
let live: AgentSession | null = null
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'claude-bg-')) })
afterEach(() => { try { live?.cancel() } catch { /* already gone */ }; live = null; rmSync(dir, { recursive: true, force: true }) })

type Step = { at: number; obj: object }
// 假 claude:按时间点吐事件,吐完之后像真 claude 一样挂着 stdin 不退出。
function timedBin(steps: Step[]): string {
  const cli = join(dir, 'timed.js')
  writeFileSync(cli, `#!/usr/bin/env node
const steps = ${JSON.stringify(steps)}
for (const s of steps) setTimeout(() => process.stdout.write(JSON.stringify(s.obj) + '\\n'), s.at)
process.stdin.resume()
setInterval(() => {}, 1000)
`)
  chmodSync(cli, 0o755)
  return cli
}

const S = 's1'
const sys = (subtype: string, extra: object = {}) => ({ type: 'system', subtype, session_id: S, ...extra })
const textDelta = (text: string) => ({ type: 'stream_event', session_id: S, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const agentCall = { type: 'assistant', session_id: S, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Research Snapseed', subagent_type: 'general-purpose', run_in_background: true, prompt: 'p' } }] } }
const receipt = { type: 'user', session_id: S, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata — never quote it.)\nagentId: a1' }] }] } }
const result = (r: string) => ({ type: 'result', subtype: 'success', is_error: false, result: r, session_id: S })

// 第一轮:开一个后台子代理 → 回执 → 「还在跑」→ result #1(此时子代理还在跑)
const turn1: Step[] = [
  { at: 0, obj: sys('init') }, { at: 0, obj: sys('status', { status: 'requesting' }) },
  { at: 10, obj: { type: 'stream_event', session_id: S, event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tu1', name: 'Agent', input: {} } } } },
  { at: 20, obj: agentCall },
  { at: 30, obj: sys('background_tasks_changed', { tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'Research Snapseed' }] }) },
  { at: 30, obj: sys('task_started', { task_id: 'a1', tool_use_id: 'tu1', is_backgrounded: true, task_type: 'local_agent' }) },
  { at: 40, obj: receipt },
  { at: 50, obj: sys('status', { status: 'requesting' }) },
  { at: 60, obj: textDelta('两路调研还在跑') },
  { at: 70, obj: result('两路调研还在跑') },
]
// 子代理 1.5s 后才跑完 → CLI 自己起第二轮 → 主代理拿结果继续 → result #2
const turn2: Step[] = [
  { at: 300, obj: { type: 'assistant', session_id: S, parent_tool_use_id: 'tu1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x1', name: 'WebFetch', input: { url: 'https://example.com' } }] } } },
  { at: 1500, obj: sys('background_tasks_changed', { tasks: [] }) },
  { at: 1500, obj: sys('task_updated', { task_id: 'a1', patch: { status: 'completed' } }) },
  { at: 1500, obj: sys('task_notification', { task_id: 'a1', tool_use_id: 'tu1', status: 'completed', summary: 'Snapseed 有 29 个工具' }) },
  { at: 1550, obj: sys('init') }, { at: 1550, obj: sys('status', { status: 'requesting' }) },
  { at: 1600, obj: textDelta('调研结果:Snapseed 有 29 个工具') },
  { at: 1650, obj: result('调研结果') },
]

const settle = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise(r => setTimeout(() => r('HANG'), ms))])

describe('claude chat() — 后台子代理比主代理这一轮活得久', () => {
  it('★result #1 时不杀进程;子代理跑完、CLI 起第二轮,回复接在同一条消息后面;卡片 运行中 → 完成', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [timedBin([...turn1, ...turn2])], defaultModels: [] })
    let text = ''
    let doneAt = 0
    const subs: { id: string; phase: string; result?: string; step?: string; isError?: boolean }[] = []
    const statuses: string[] = []
    const t0 = Date.now()
    live = provider.chat!(
      { id: 'm1', prompt: 'x', model: 'opus-4.8', cwd: dir },
      {
        onSession: () => {}, onAssistantDelta: (t) => { text += t }, onThinkDelta: () => {},
        onSubagent: (ev) => subs.push(ev), onStatus: (s) => statuses.push(s),
        onDone: () => { doneAt = Date.now() - t0 }, onError: () => {},
      },
      process.env,
    )
    const r = await settle(live.done, 30_000)
    expect(r).not.toBe('HANG')
    expect((r as { ok: boolean }).ok).toBe(true)
    // 修之前:result #1(~70ms)就 killTree,第二轮永远不会来
    expect(doneAt).toBeGreaterThan(1400)
    expect(text).toBe('两路调研还在跑\n\n调研结果:Snapseed 有 29 个工具')
    expect(statuses.some(s => s.includes('后台还有 1 个任务在跑'))).toBe(true)
    // 回执不能把卡片置完成,也不能把内部回执原文塞进结果
    const tu1 = subs.filter(s => s.id === 'tu1')
    const firstDone = tu1.findIndex(s => s.phase === 'done')
    expect(tu1.slice(0, firstDone).some(s => s.step === '已转入后台运行')).toBe(true)
    expect(tu1.filter(s => s.phase === 'done')).toEqual([{ id: 'tu1', phase: 'done', result: 'Snapseed 有 29 个工具', isError: false }])
    // 后台期间子代理的工具调用照旧挂在它的卡片上
    expect(tu1.some(s => s.step && s.step !== '已转入后台运行')).toBe(true)
  })

  it('子代理在这一轮中途就完成并被消化:result 照旧立即收尾(不多等)', async () => {
    const steps: Step[] = [
      ...turn1.slice(0, 7),   // 到回执为止
      { at: 45, obj: sys('background_tasks_changed', { tasks: [] }) },
      { at: 45, obj: sys('task_notification', { task_id: 'a1', tool_use_id: 'tu1', status: 'completed', summary: 'FAST-1' }) },
      { at: 50, obj: sys('status', { status: 'requesting' }) },
      { at: 60, obj: textDelta('MAIN-DONE GOT FAST-1') },
      { at: 70, obj: result('MAIN-DONE') },
    ]
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [timedBin(steps)], defaultModels: [] })
    const t0 = Date.now()
    live = provider.chat!(
      { id: 'm2', prompt: 'x', model: 'opus-4.8', cwd: dir },
      { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} },
      process.env,
    )
    const r = await settle(live.done, 30_000)
    expect(r).not.toBe('HANG')
    expect((r as { ok: boolean }).ok).toBe(true)
    expect(Date.now() - t0).toBeLessThan(20_000)
  })

  it('停车期间点「停止」:进程被回收,done 照常结束', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [timedBin(turn1)], defaultModels: [] })
    live = provider.chat!(
      { id: 'm3', prompt: 'x', model: 'opus-4.8', cwd: dir },
      { onSession: () => {}, onAssistantDelta: () => {}, onThinkDelta: () => {}, onDone: () => {}, onError: () => {} },
      process.env,
    )
    expect(await settle(live.done, 600)).toBe('HANG')   // 停着在等后台子代理
    live.cancel()
    expect(await settle(live.done, 30_000)).not.toBe('HANG')
  })
})

describe('claude run() — 同一个问题在工作流那条路上(见 [[trap-two-call-sites-run-vs-chat]])', () => {
  it('result #1 时不杀;第二轮结束才 done;子代理完成用的是通知里的摘要', async () => {
    const provider = makeClaudeProvider({ bin: 'node', preArgs: [timedBin([...turn1, ...turn2])], defaultModels: [] })
    const subs: { id: string; phase: string; result?: string }[] = []
    const logs: string[] = []
    const t0 = Date.now()
    live = provider.run(
      { stageKey: 'design', agentId: 'design:x', name: 'D', prompt: 'x', cwd: dir, model: 'opus-4.8' },
      {
        onLog: (l) => logs.push(l.text), onState: () => {}, onConfirm: async () => 'allow', onInput: async () => '',
        onSubagent: (ev) => subs.push(ev), onDone: () => {}, onError: () => {},
      },
      process.env,
    )
    const r = await settle(live.done, 30_000)
    expect(r).not.toBe('HANG')
    expect((r as { ok: boolean }).ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThan(1400)
    expect(subs.filter(s => s.id === 'tu1' && s.phase === 'done')).toEqual([{ id: 'tu1', phase: 'done', result: 'Snapseed 有 29 个工具', isError: false }])
    expect(logs).toContain('子代理已转入后台运行')
  })
})
