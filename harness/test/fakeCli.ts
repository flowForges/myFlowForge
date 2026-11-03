// 把 fixtures/executors/fake-cli.mjs 装进临时 bin 目录,并记下它起的进程,测试结束时收干净
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTime } from '../src/lib/proc/pgids'

const SOURCE = join(__dirname, 'fixtures', 'executors', 'fake-cli.mjs')

export interface PidRecord {
  role: 'cli' | 'child' | 'grandchild' | 'escaped' | 'background'
  pid: number
  start?: string
}

export interface FakeCli {
  dir: string
  /** 可执行文件的绝对路径 */
  file: string
  pids(): PidRecord[]
  calls(): { argv: string[]; stdin: string; envNames: string[]; env: Record<string, string>; cwd: string }[]
  /** 等某个角色的进程记下 pid */
  waitPid(role: PidRecord['role'], ms?: number): Promise<number>
}

const fakes: FakeCli[] = []
const extra: { pid: number; start: string }[] = []

const jsonl = (f: string) =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
    : []

function makeFake(dir: string, name: string): FakeCli {
  const file = join(dir, name)
  // 绝对路径的解释器:测试给子进程的 PATH 可能没有 node
  writeFileSync(file, readFileSync(SOURCE, 'utf8').replace(/^#!.*/, `#!${process.execPath}`))
  chmodSync(file, 0o755)
  const fake: FakeCli = {
    dir,
    file,
    pids: () => jsonl(join(dir, 'pids.jsonl')),
    calls: () => jsonl(join(dir, 'calls.jsonl')),
    async waitPid(role, ms = 15_000) {
      const end = Date.now() + ms
      for (;;) {
        const hit = fake.pids().find(p => p.role === role)
        if (hit) return hit.pid
        if (Date.now() > end) throw new Error(`fake ${role} never reported a pid`)
        await new Promise(res => setTimeout(res, 20))
      }
    },
  }
  return fake
}

export function installFake(scenario: object = {}, name = 'codex'): FakeCli {
  const fake = makeFake(realpathSync(mkdtempSync(join(tmpdir(), 'mffai-fakecli-'))), name)
  writeFileSync(join(fake.dir, 'scenario.json'), JSON.stringify(scenario))
  fakes.push(fake)
  return fake
}

const reusable = new Map<string, FakeCli>()

/**
 * 同一个文件反复用,只换剧本:macOS 第一次执行新文件要多花约 0.4 s(实测),用例多的文件全花在这上面。
 * 改文件本身(chmod、mtime)的用例不能用它。parent 要活过单个用例。文件结束时调 disposeReusableFakes
 */
export function reusableFake(scenario: object, name: string, parent: string): FakeCli {
  let fake = reusable.get(name)
  if (!fake) reusable.set(name, (fake = makeFake(realpathSync(mkdtempSync(join(parent, 'mffai-fakecli-'))), name)))
  rmSync(join(fake.dir, 'calls.jsonl'), { force: true })
  rmSync(join(fake.dir, 'pids.jsonl'), { force: true })
  writeFileSync(join(fake.dir, 'scenario.json'), JSON.stringify(scenario))
  return fake
}

export function disposeReusableFakes(): void {
  for (const f of reusable.values()) rmSync(f.dir, { recursive: true, force: true })
  reusable.clear()
}

/** 记下测试自己起的进程(spawn 之后立刻调);清理时启动时间仍一致才杀 */
export function trackPid(pid: number): void {
  const start = startTime(pid)
  if (start) extra.push({ pid, start })
}

const killIfSame = ({ pid, start }: { pid: number; start?: string }) => {
  if (!start || startTime(pid) !== start) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 查完之后刚好退了
  }
}

/** afterEach:按 pid + 启动时间杀掉还活着的,删临时 bin 目录 */
export function cleanupFakes(): void {
  for (const f of fakes.splice(0)) {
    for (const p of f.pids()) killIfSame(p)
    rmSync(f.dir, { recursive: true, force: true })
  }
  for (const f of reusable.values()) {
    for (const p of f.pids()) killIfSame(p)
    rmSync(join(f.dir, 'pids.jsonl'), { force: true })
  }
  for (const p of extra.splice(0)) killIfSame(p)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function waitDead(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await new Promise(res => setTimeout(res, 20))
  }
  return !isAlive(pid)
}
