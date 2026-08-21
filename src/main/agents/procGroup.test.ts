import { describe, it, expect, afterEach, vi } from 'vitest'
import { execa, type ResultPromise } from 'execa'
import { spawnAgent, killTree, killAllAgentTrees, liveAgentCount, killTreeWindows } from './procGroup'

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
    const t = setTimeout(() => reject(new Error('孙进程 pid 没打出来')), 20000)
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
  }, 60000)

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
  }, 60000)

  it('没有独立进程组的子进程绝不走负 pid —— 否则杀的是 app 自己所在的组', async () => {
    // 直接 execa 起(不经 spawnAgent),killTree 必须退回单杀:进程死掉,而它的孙进程照样漏(可接受),
    // 关键是【本进程】必须活着 —— 如果这里误发了 kill(-pid),测试进程自己就先没了。
    const { child, grandPid } = await spawnWithGrandchild('plain')
    strays.push(grandPid)

    killTree(child)

    expect(await settleDead(child.pid!)).toBe(false)
    expect(alive(process.pid)).toBe(true)
  }, 60000)

  it('★ 安全闸门:对不是我们建的进程组,绝不发负 pid 信号', async () => {
    // 契约本身就是「不发负 pid」,而不是它的某个副作用 —— 进程树补刀已经会把孙进程收掉了,所以这里
    // 直接盯 process.kill 的调用:出现负数就意味着我们对一个来路不明的组开了枪,而那个组可能是 app 自己的。
    const { child, grandPid } = await spawnWithGrandchild('plain')   // 没经过 spawnAgent
    strays.push(grandPid)
    const spy = vi.spyOn(process, 'kill')
    try {
      killTree(child)
      const negatives = spy.mock.calls.map(c => Number(c[0])).filter(n => n < 0)
      expect(negatives).toEqual([])
    } finally { spy.mockRestore() }
    expect(alive(process.pid)).toBe(true)
  }, 60000)

  it('进程已经退出时静默收尾,不抛', async () => {
    const child = spawnAgent('/bin/sh', ['-c', 'exit 0'], { reject: false })
    await child
    expect(() => killTree(child)).not.toThrow()
  }, 60000)
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
  }, 60000)

  it('自己正常退出的子进程会从活进程表里摘除(否则退出时对一堆死 pid 发信号)', async () => {
    const before = liveAgentCount()
    const child = spawnAgent('/bin/sh', ['-c', 'exit 0'], { reject: false })
    await child
    await sleep(100)
    expect(liveAgentCount()).toBe(before)
  }, 60000)
})

describe('detached 不能破坏 stdio', () => {
  it('★ stdin 管道照常可写 —— claude 的对话握手全靠往 child.stdin 写(控制协议 + 用户消息)', async () => {
    const child = spawnAgent('/bin/sh', ['-c', 'read line; echo "got:$line"'], { reject: false })
    child.stdin?.write('hello-handshake\n')
    const out = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stdout 没回来')), 20000)
      child.stdout?.on('data', (b: Buffer) => { clearTimeout(t); resolve(b.toString()) })
    })
    expect(out.trim()).toBe('got:hello-handshake')
    await child
  }, 60000)
})

// ★★ 真 codex 取证(2026-08-20)推翻了「杀进程组就够了」这个前提:
//    CANCEL 前  sleep: pid=90995 ppid=90410 pgid=90995  ← pgid == 自己的 pid
//    codex 给它派生的每条 shell 命令【另建了进程组】(setsid,做沙箱/超时隔离),所以它根本不在我们
//    detached 出来的那个组里,kill(-pid) 打不到。但它当时【仍在我们的进程树里】(ppid 指向 codex),
//    所以按 ppid 递归收集进程树才是能杀干净的那条路。
describe('子进程另建进程组(真 codex 就是这么干的)', () => {
  /** 桩:中间进程活着,但把真正干活的命令 setsid 进新组 —— 复刻 codex 的拓扑。 */
  async function spawnRegrouped(): Promise<{ child: ResultPromise; grandPid: number }> {
    // 深度要够:真 codex 是「node 壳 → rust 本体 → shell → 命令」好几层,只查直接子进程是抓不到的。
    // 这里 bash → python3 → (fork+setsid) sleep,孙进程在第 2 层。
    const child = spawnAgent('/bin/bash', ['-c', '/usr/bin/python3 -c "$0"; :'   /* 尾巴阻止 bash 对单条命令做隐式 exec —— 否则 bash 被替换掉,层数塌回 1 */, [
      'import os, sys, time',
      'pid = os.fork()',
      'if pid == 0:',
      '    os.setsid()',                                  // ← 新进程组,和 codex 一样
      '    os.execvp("sleep", ["sleep", "300"])',
      'sys.stdout.write(str(pid) + "\\n"); sys.stdout.flush()',
      'time.sleep(300)',                                  // 中间进程不退,维持 ppid 链
    ].join('\n')], { reject: false })
    const grandPid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('孙进程 pid 没打出来')), 20000)
      child.stdout?.on('data', (b: Buffer) => {
        const n = Number(b.toString().trim().split('\n')[0])
        if (Number.isFinite(n) && n > 0) { clearTimeout(t); resolve(n) }
      })
    })
    return { child, grandPid }
  }

  it('★★ 另建了进程组的孙进程也必须被杀掉 —— 这正是真 codex 漏掉的那一个', async () => {
    const { child, grandPid } = await spawnRegrouped()
    strays.push(grandPid)
    // 先确认拓扑真的复刻对了:它的 pgid 就是它自己(不在我们的组里)。
    const { stdout } = await execa('ps', ['-o', 'pgid=', '-p', String(grandPid)], { reject: false })
    expect(Number(stdout.trim()), '桩没复刻出「另建进程组」').toBe(grandPid)

    killTree(child)

    expect(await settleDead(grandPid)).toBe(false)
  }, 60000)
})

// 进程组和进程树管的是【两种不同的拓扑】,缺一不可:
//   · 进程树(ppid)—— 抓「另建了进程组」的后代(codex 就这么干)。前提是 ppid 链还在。
//   · 进程组      —— 抓「ppid 链已经断了」的后代:CLI 自己先退了/崩了,后台命令被 init 收养,
//                    ps 里再也看不出它跟我们的关系,但它还留在我们 detached 出来的那个组里。
describe('CLI 先退、只剩进程组认得的后代', () => {
  it('★ ppid 链断了也要杀掉 —— 这是进程组那一刀唯一能救的场景', async () => {
    // sh 起了后台命令就立刻退出:sleep 被 init 收养(ppid=1),但 pgid 仍是 sh 的 pid。
    const child = spawnAgent('/bin/sh', ['-c', 'sleep 300 >/dev/null 2>&1 & echo $!; exit 0'   /* 重定向:否则后台命令继承 stdout 管道,管道不关 execa 的 promise 就永远不 resolve */], { reject: false })
    const grandPid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('孙进程 pid 没打出来')), 20000)
      child.stdout?.on('data', (b: Buffer) => {
        const n = Number(b.toString().trim().split('\n')[0])
        if (Number.isFinite(n) && n > 0) { clearTimeout(t); resolve(n) }
      })
    })
    strays.push(grandPid)
    await child                                   // 等 sh 真的退干净
    const { stdout } = await execa('ps', ['-o', 'ppid=,pgid=', '-p', String(grandPid)], { reject: false })
    const [ppid, pgid] = stdout.trim().split(/\s+/).map(Number)
    expect(ppid, '桩没复刻出「已被 init 收养」').toBe(1)
    expect(pgid, '桩没复刻出「仍在我们的组里」').toBe(child.pid)

    killTree(child)

    expect(await settleDead(grandPid)).toBe(false)
  }, 60000)
})

// ── Windows 分支 ────────────────────────────────────────────────────────────────────────────────
// 真机上从没跑过(没有 Windows 机器),所以这里只钉死【调用形状和顺序】—— 顺序正是 POSIX 分支踩过的坑:
// 必须先把树处理完,才能碰父进程。
describe('killTreeWindows', () => {
  it('用 taskkill /T /F 杀整棵树', () => {
    const calls: string[][] = []
    killTreeWindows(4242, () => {}, (args) => { calls.push(args) })
    expect(calls).toEqual([['/pid', '4242', '/T', '/F']])
  })

  it('★ taskkill 跑完之前绝不动父进程 —— 先杀父进程会让后代被系统改认爹,/T 就再也找不到它们', () => {
    const order: string[] = []
    killTreeWindows(4242, () => order.push('single'), () => { order.push('taskkill') })
    expect(order[0]).toBe('taskkill')
  })

  it('taskkill 成功后不再单杀一次(父进程已经被 /F 带走了)', () => {
    const single = vi.fn()
    killTreeWindows(4242, single, () => {})
    expect(single).not.toHaveBeenCalled()
  })

  it('taskkill 不在 / 进程已退出(非零退出会抛)→ 退回单杀,不让停止流程炸掉', () => {
    const single = vi.fn()
    expect(() => killTreeWindows(4242, single, () => { throw new Error('not found') })).not.toThrow()
    expect(single).toHaveBeenCalledTimes(1)
  })
})
