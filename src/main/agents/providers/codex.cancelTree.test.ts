import { describe, it, expect, afterEach } from 'vitest'
import { execa } from 'execa'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeCodexProvider } from './codex'

// 「停止」必须杀掉 codex 派生的 shell 命令,而不只是 codex 自己。
//
// procGroup.test.ts 已经单独钉过 killTree 的内核行为;这一条走的是【真 provider 路径】—— 真的
// makeCodexProvider().chat() 起进程、真的 session.cancel() 停,只是把 bin 换成一个行为像 codex 的桩
// (吐一行 thread.started,再派生一个后台命令,然后挂住)。这样 codex.ts 里的 spawnAgent / killTree 接线
// 一旦被改回 execa / child.kill('SIGTERM'),这条就会红 —— 单测 procGroup 是拦不住那种回归的。

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function settleDead(pid: number, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (!alive(pid)) return false; await sleep(50) }
  return alive(pid)
}

/** 一个行为像 codex 的桩:报 thread id → 派生后台命令(把它的 pid 写进文件)→ 挂住不退。 */
function stubCodex(dir: string): string {
  const bin = join(dir, 'codex-stub')
  writeFileSync(bin, [
    '#!/bin/bash',
    'echo \'{"type":"thread.started","thread_id":"t-stub"}\'',
    'sleep 300 &',
    // 原子写:先写临时文件再 rename,否则并发跑测试时可能读到半截内容。
    `echo $! > ${JSON.stringify(join(dir, 'grand.pid.tmp'))} && mv ${JSON.stringify(join(dir, 'grand.pid.tmp'))} ${JSON.stringify(join(dir, 'grand.pid'))}`,
    'wait',
  ].join('\n'))
  chmodSync(bin, 0o755)
  return bin
}

const strays: number[] = []
afterEach(async () => {
  for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已经死了 */ } }
  await sleep(50)
})

describe('codex chat 的停止', () => {
  it('★ session.cancel() 要连它派生的 shell 命令一起杀掉,不能留孤儿', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-cancel-'))
    const provider = makeCodexProvider({ bin: stubCodex(dir), defaultModels: [{ id: 'm', label: 'm' }] })

    let sessionId = ''
    const session = provider.chat!(
      { id: 'a1', prompt: 'hi', model: 'm', cwd: dir },
      {
        onSession: (id) => { sessionId = id },
        onAssistantDelta: () => {}, onThinkDelta: () => {},
        onDone: () => {}, onError: () => {},
      },
      process.env,
    )

    // 等桩把后台命令派生出来(pid 文件出现)。
    const { readFileSync, existsSync } = await import('node:fs')
    const pidFile = join(dir, 'grand.pid')
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !existsSync(pidFile)) await sleep(50)
    expect(existsSync(pidFile), '桩没能派生出后台命令').toBe(true)
    const grandPid = Number(readFileSync(pidFile, 'utf8').trim())
    strays.push(grandPid)
    expect(alive(grandPid)).toBe(true)
    expect(sessionId).toBe('t-stub')       // 确实走通了真 provider 的事件解析

    session.cancel()

    expect(await settleDead(grandPid)).toBe(false)   // ★ 孙进程必须死
  }, 90000)

  it('★★ 对照:同样的桩,如果只杀直接子进程,后台命令会活下来(这就是被修掉的行为)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-cancel-ctl-'))
    const child = execa(stubCodex(dir), [], { reject: false })   // 不经 spawnAgent
    const { readFileSync, existsSync } = await import('node:fs')
    const pidFile = join(dir, 'grand.pid')
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !existsSync(pidFile)) await sleep(50)
    const grandPid = Number(readFileSync(pidFile, 'utf8').trim())
    strays.push(grandPid)

    child.kill('SIGTERM')                                        // 老写法
    await settleDead(child.pid!, 3000)

    expect(alive(grandPid)).toBe(true)
  }, 90000)
})
