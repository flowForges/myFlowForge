import { describe, it, expect, afterEach } from 'vitest'
import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree, killAllAgentTrees, liveAgentCount } from './procGroup'

// ★ 这里【必须】用真进程,不能用假 runner:要证明的正是「SIGTERM 之后孙进程还活不活着」,这是内核层面的
//   父子/进程组行为,任何 mock 都只会复述我们自己的假设。(教训见 2026-07-19 那次假 GitRunner 漏掉致命
//   git bug —— 破坏性操作一律真集成测试。)

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 等到 pid 死掉,或超时。返回它最终是否还活着。 */
async function settleDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return false
    await sleep(50)
  }
  return alive(pid)
}

/**
 * 起一个真的会派生【孙进程】的 shell:`sleep 300 &` 后台跑,把它的 pid 打到 stdout,然后 wait 挂住。
 * 这就是 codex 跑 `/bin/zsh -lc 'npm run build'` 的最小复刻。
 */
async function spawnWithGrandchild(via: 'agent' | 'plain'): Promise<{ child: ResultPromise; grandPid: number }> {
  const args = ['-c', 'sleep 300 & echo $!; wait']
  const child = via === 'agent'
    ? spawnAgent('/bin/sh', args, { reject: false })
    : execa('/bin/sh', args, { reject: false })
  const grandPid = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('孙进程 pid 没打出来')), 5000)
    child.stdout?.on('data', (b: Buffer) => {
      const n = Number(b.toString().trim().split('\n')[0])
      if (Number.isFinite(n) && n > 0) { clearTimeout(t); resolve(n) }
    })
  })
  return { child, grandPid }
}

const strays: number[] = []
afterEach(async () => {
  killAllAgentTrees('SIGKILL')
  for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* 已经死了 */ } }
  await sleep(50)
})

describe('killTree', () => {
  it('★ 杀掉整棵树 —— CLI 派生的孙进程不许活下来', async () => {
    const { child, grandPid } = await spawnWithGrandchild('agent')
    strays.push(grandPid)
    expect(alive(grandPid)).toBe(true)

    killTree(child)

    expect(await settleDead(grandPid)).toBe(false)
    expect(alive(child.pid!)).toBe(false)
  }, 20000)

  it('★★ 对照组:老写法 child.kill() 确实会漏孤儿(这就是被修掉的 bug 本身)', async () => {
    // 不走 spawnAgent(没有独立进程组)+ 只杀单个 pid = 修复前的行为。孙进程活下来 = bug 复现。
    const { child, grandPid } = await spawnWithGrandchild('plain')
    strays.push(grandPid)

    child.kill('SIGTERM')
    await settleDead(child.pid!, 3000)

    // 父死了,孙还活着,而且被 init 收养(PPID=1)。
    expect(alive(grandPid)).toBe(true)
    const { stdout } = await execa('ps', ['-o', 'ppid=', '-p', String(grandPid)], { reject: false })
    expect(stdout.trim()).toBe('1')
  }, 20000)

  it('没有独立进程组的子进程绝不走负 pid —— 否则杀的是 app 自己所在的组', async () => {
    // 直接 execa 起(不经 spawnAgent),killTree 必须退回单杀:进程死掉,而它的孙进程照样漏(可接受),
    // 关键是【本进程】必须活着 —— 如果这里误发了 kill(-pid),测试进程自己就先没了。
    const { child, grandPid } = await spawnWithGrandchild('plain')
    strays.push(grandPid)

    killTree(child)

    expect(await settleDead(child.pid!)).toBe(false)
    expect(alive(process.pid)).toBe(true)
  }, 20000)

  it('★ 安全闸门:不是我们建的进程组,即便它确实有独立组也不许杀组', async () => {
    // 这条专门钉死 ownGroup 这道闸门。直接用 execa 起一个 detached 的进程 —— 它【确实】有自己的进程组
    // (所以 kill(-pid) 会成功杀掉整组),但它没经过 spawnAgent,不在 ownGroup 里。killTree 必须退回单杀,
    // 于是孙进程活下来。这就是闸门唯一可观测的行为差异:宁可漏一个孤儿,也不对来路不明的 pid 发负信号。
    const args = ['-c', 'sleep 300 & echo $!; wait']
    const child = execa('/bin/sh', args, { reject: false, detached: true })
    const grandPid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('孙进程 pid 没打出来')), 5000)
      child.stdout?.on('data', (b: Buffer) => {
        const n = Number(b.toString().trim().split('\n')[0])
        if (Number.isFinite(n) && n > 0) { clearTimeout(t); resolve(n) }
      })
    })
    strays.push(grandPid, child.pid!)

    killTree(child)

    expect(await settleDead(child.pid!)).toBe(false)   // 它自己被单杀了
    expect(alive(grandPid)).toBe(true)                 // 但组没被杀 → 孙进程还在
  }, 20000)

  it('进程已经退出时静默收尾,不抛', async () => {
    const child = spawnAgent('/bin/sh', ['-c', 'exit 0'], { reject: false })
    await child
    expect(() => killTree(child)).not.toThrow()
  }, 20000)
})

describe('killAllAgentTrees(app 退出兜底)', () => {
  it('★ detached 关掉了 execa 自带的 cleanup,退出兜底必须把树杀干净', async () => {
    const a = await spawnWithGrandchild('agent')
    const b = await spawnWithGrandchild('agent')
    strays.push(a.grandPid, b.grandPid)
    expect(liveAgentCount()).toBeGreaterThanOrEqual(2)

    killAllAgentTrees()
    // ★ 同步清空,不能指望 'close' 事件:before-quit 是同步的,app 可能在事件回调跑起来之前就退出了。
    expect(liveAgentCount()).toBe(0)

    expect(await settleDead(a.grandPid)).toBe(false)
    expect(await settleDead(b.grandPid)).toBe(false)
  }, 20000)

  it('自己正常退出的子进程会从活进程表里摘除(否则退出时对一堆死 pid 发信号)', async () => {
    const before = liveAgentCount()
    const child = spawnAgent('/bin/sh', ['-c', 'exit 0'], { reject: false })
    await child
    await sleep(100)
    expect(liveAgentCount()).toBe(before)
  }, 20000)
})

describe('detached 不能破坏 stdio', () => {
  it('★ stdin 管道照常可写 —— claude 的对话握手全靠往 child.stdin 写(控制协议 + 用户消息)', async () => {
    const child = spawnAgent('/bin/sh', ['-c', 'read line; echo "got:$line"'], { reject: false })
    child.stdin?.write('hello-handshake\n')
    const out = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stdout 没回来')), 5000)
      child.stdout?.on('data', (b: Buffer) => { clearTimeout(t); resolve(b.toString()) })
    })
    expect(out.trim()).toBe('got:hello-handshake')
    await child
  }, 20000)
})
