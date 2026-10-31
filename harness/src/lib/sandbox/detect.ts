// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// 沙箱级别探测(spec §7,R10)。工作进程启动时跑一次,结果由内核缓存。
// - darwin:`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` 退出 0 → full;已在别的沙箱里(嵌套 → 71)等失败 → none。
// - linux:bwrap 只认 root 所有、不可被他人改写的(/usr/bin、/usr/local/bin 优先,再 PATH;review I2)。用与 bwrapArgs 相同的参数集合跑一次 bwrap(含 --proc、--unshare-ipc、--tmpfs、--setenv / --unsetenv、--chdir、--;
//   不带 --new-session),通过 → full;去掉 --unshare-net 才通过 → partial(netns);都不过 → none(userns);没有 bwrap → none(bwrap)。
// - 其他平台 → none(platform);sandbox.enabled:false → none(disabled),什么都不跑。
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { SandboxMissing } from '../../protocol/rpc'

export type SandboxLevel = 'full' | 'partial' | 'none'

export interface DetectResult {
  level: SandboxLevel
  missing: SandboxMissing[]
  /** linux:探测用的 bwrap 绝对路径(plan 用同一个) */
  bwrap?: string
}

/** 跑一条探测命令,返回退出码(被信号杀 / 超时 → 非 0);起不来 → reject */
export type RunFn = (file: string, args: string[], timeoutMs: number) => Promise<number>

export const PROBE_TIMEOUT_MS = 3000

export const DARWIN_PROBE = ['-p', '(version 1)(allow default)', '/usr/bin/true']

/** 与 bwrapArgs 同一组参数(只读根、私有 /tmp、各命名空间、环境、chdir、--) */
export function BWRAP_PROBE(net: boolean): string[] {
  return [
    '--die-with-parent', '--unshare-user', '--unshare-pid', '--unshare-ipc',
    ...(net ? ['--unshare-net'] : []),
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--unsetenv', 'ELECTRON_RUN_AS_NODE', '--setenv', 'MFFAI_PROBE', '1',
    '--chdir', '/', '--', '/bin/sh', '-c', 'true',
  ]
}

/** 默认:新进程组、不接 stdio;超时杀整组 */
export const defaultRun: RunFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: true })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.once('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
  })

export interface BwrapFs {
  realpath(p: string): string
  stat(p: string): { uid: number; mode: number; isFile(): boolean; isDirectory(): boolean }
}
const realFs: BwrapFs = { realpath: p => realpathSync.native(p), stat: p => statSync(p) }

/**
 * 可信的 bwrap:realpath 是 root 所有、组 / 其他不可写的可执行文件,且路上每一级目录都是 root 所有、组 / 其他不可写
 * (review I2:PATH 里 ~/.local/bin 之类的 bwrap 能被沙箱里的命令换成直接 exec 的假货,下次启动就报 full)。返回 realpath
 */
export function trustedBwrap(p: string, fs: BwrapFs = realFs): string | undefined {
  try {
    const r = fs.realpath(p)
    const st = fs.stat(r)
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0 || (st.mode & 0o111) === 0) return undefined
    for (let d = dirname(r); ; d = dirname(d)) {
      const ds = fs.stat(d)
      if (!ds.isDirectory() || ds.uid !== 0 || (ds.mode & 0o022) !== 0) return undefined
      if (d === dirname(d)) break
    }
    return r
  } catch {
    return undefined
  }
}

/** 先 /usr/bin/bwrap、/usr/local/bin/bwrap,再 PATH 里的绝对目录;只认 trustedBwrap 通过的 */
export function findBwrap(path: string | undefined = process.env.PATH, fs: BwrapFs = realFs): string | undefined {
  const dirs = (path ?? '').split(delimiter).filter(d => d && isAbsolute(d))
  for (const c of ['/usr/bin/bwrap', '/usr/local/bin/bwrap', ...dirs.map(d => join(d, 'bwrap'))]) {
    const t = trustedBwrap(c, fs)
    if (t) return t
  }
  return undefined
}

const passes = (run: RunFn, file: string, args: string[]) => run(file, args, PROBE_TIMEOUT_MS).then(c => c === 0, () => false)

export async function detectSandbox(o: {
  platform: NodeJS.Platform
  enabled: boolean
  run?: RunFn
  /** 默认 findBwrap() */
  findBwrap?: () => string | undefined
}): Promise<DetectResult> {
  if (!o.enabled) return { level: 'none', missing: ['disabled'] }
  const run = o.run ?? defaultRun
  if (o.platform === 'darwin') {
    return (await passes(run, '/usr/bin/sandbox-exec', DARWIN_PROBE)) ? { level: 'full', missing: [] } : { level: 'none', missing: ['sandbox-exec'] }
  }
  if (o.platform === 'linux') {
    const bwrap = (o.findBwrap ?? findBwrap)()
    if (!bwrap) return { level: 'none', missing: ['bwrap'] }
    if (await passes(run, bwrap, BWRAP_PROBE(true))) return { level: 'full', missing: [], bwrap }
    if (await passes(run, bwrap, BWRAP_PROBE(false))) return { level: 'partial', missing: ['netns'], bwrap }
    return { level: 'none', missing: ['userns'] }
  }
  return { level: 'none', missing: ['platform'] }
}
