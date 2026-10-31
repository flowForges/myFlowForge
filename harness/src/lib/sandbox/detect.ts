// 设计参考 anthropic-experimental/sandbox-runtime(Apache-2.0)
// 沙箱级别探测(spec §7,R10)。工作进程启动时跑一次,结果由内核缓存。
// - darwin:`sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` 退出 0 → full;已在别的沙箱里(嵌套 → 71)等失败 → none。
// - linux:用与 bwrapArgs 相同的参数集合跑一次 bwrap(含 --proc、--unshare-ipc、--tmpfs、--setenv / --unsetenv、--chdir、--;
//   不带 --new-session),通过 → full;去掉 --unshare-net 才通过 → partial(netns);都不过 → none(userns);没有 bwrap → none(bwrap)。
// - 其他平台 → none(platform);sandbox.enabled:false → none(disabled),什么都不跑。
import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
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

const isExecutable = (p: string) => {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** PATH 里的 bwrap,其次 /usr/bin/bwrap;只认绝对目录 */
export function findBwrap(path: string | undefined = process.env.PATH): string | undefined {
  for (const dir of (path ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const p = join(dir, 'bwrap')
    if (isExecutable(p)) return p
  }
  return isExecutable('/usr/bin/bwrap') ? '/usr/bin/bwrap' : undefined
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
