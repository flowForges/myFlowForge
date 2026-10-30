// shell 工具的环境(spec §7.1):只传白名单变量;POSIX 的 PATH 合并登录 shell 的 PATH 与常见安装目录
// (开机自启的后台继承 launchd 的最小 PATH,npm / brew 装的命令找不到)
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'

const ALLOW = new Set(
  [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
  ],
)
/** 代理变量大小写各一套;Windows 的变量名本身不区分大小写 → 一律按大写比 */
const allowed = (k: string) => ALLOW.has(k.toUpperCase()) || k.startsWith('LC_')

/** 代理 URL 去掉 `user:pass@`(子进程用不着用户的代理凭据,模型 `env` 一下就能看到);有无 scheme 都处理 */
const PROXY = /^(HTTPS?|ALL)_PROXY$/
const stripUserinfo = (v: string) => v.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)?[^/?#]*@/, '$1')

const FIXED = { MFFAI: '1', GIT_TERMINAL_PROMPT: '0', CI: '1' }

/** 常见安装目录(登录 shell 探测失败时的兜底) */
function fallbackDirs(platform: NodeJS.Platform, home: string): string[] {
  return [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
    '/usr/local/bin',
    '/usr/local/sbin',
    `${home}/.local/bin`,
    `${home}/.cargo/bin`,
    `${home}/.bun/bin`,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]
}

/** 合并 PATH:去重、保序;空项与相对路径丢掉(它们相对工作目录解析,仓库里放个 `ls` 就会被执行) */
function mergePath(lists: (string | undefined)[]): string {
  const seen = new Set<string>()
  for (const list of lists) for (const p of (list ?? '').split(':')) if (p !== '' && isAbsolute(p)) seen.add(p)
  return [...seen].join(':')
}

export function shellEnv(base: NodeJS.ProcessEnv, opts: { platform: NodeJS.Platform; home: string; loginPath?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && allowed(k)) env[k] = PROXY.test(k.toUpperCase()) ? stripUserinfo(v) : v
  for (const k of Object.keys(env)) if (k.toUpperCase() in FIXED) delete env[k]
  if (opts.platform !== 'win32') {
    for (const k of Object.keys(env)) if (k !== 'PATH' && k.toUpperCase() === 'PATH') delete env[k]
    env.PATH = mergePath([base.PATH, opts.loginPath, fallbackDirs(opts.platform, opts.home).join(':')])
    env.HOME ??= opts.home
  }
  return { ...env, ...FIXED }
}

/** 运行登录 shell 的方式(测试注入);返回 stdout,失败 / 超时 → reject */
export type ShellExec = (shell: string, args: string[], timeoutMs: number) => Promise<string>

const PROBE_TIMEOUT = 3000
const memo = new WeakMap<ShellExec, Promise<string>>()

/** 默认:新进程组(没有控制终端,`-i` 不会去抢 tty);超时杀整组;stdin 关闭 */
const defaultExec: ShellExec = (shell, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true, env: process.env })
    const out: Buffer[] = []
    let size = 0
    child.stdout!.on('data', (b: Buffer) => {
      if (size < 1 << 20) out.push(b)
      size += b.length
    })
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // 已退出
      }
      reject(new Error('login shell timed out'))
    }, timeoutMs)
    child.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`login shell exited ${code}`))
    })
  })

/**
 * 登录 shell 的 PATH:`$SHELL -ilc 'printf …%s… "$PATH"'`,3 s 超时,失败 → ''。
 * rc 文件可能往 stdout 打字,所以 PATH 夹在随机标记中间取。每个 exec 只探测一次(默认 exec = 每进程一次)
 */
export function loginShellPath(exec: ShellExec = defaultExec, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<string> {
  const shell = env.SHELL
  if (platform === 'win32' || !shell || !isAbsolute(shell)) return Promise.resolve('')
  let p = memo.get(exec)
  if (!p) {
    const mark = `__MFFAI_${randomBytes(6).toString('hex')}__`
    p = exec(shell, ['-ilc', `printf '${mark}%s${mark}' "$PATH"`], PROBE_TIMEOUT).then(
      out => {
        const m = new RegExp(`${mark}([^\\n]*?)${mark}`).exec(out)
        return m ? m[1] : ''
      },
      () => '',
    )
    memo.set(exec, p)
  }
  return p
}
