import { mkdirSync, writeFileSync, chmodSync, existsSync, accessSync, constants } from 'node:fs'
import { join, delimiter, resolve } from 'node:path'
import { SHIMMED_COMMANDS } from '../../shared/authPolicy'

/**
 * PATH shim 目录 —— 把 Forge 插到 agent 和高危命令之间。
 *
 * ★★这一层是**唯一对 qoder / cursor / opencode / copilot 也成立**的授权入口:它们既没有审批协议
 *  也没有 hook,只支持「全放行」。claude 有协议、gemini/qwen 有 hook,但那些都是**每个 provider 一套**;
 *  这一层不需要 CLI 配合任何东西 —— 它只需要 agent 会去 PATH 上找命令。
 *  (技术本身在用户这台机器上已经被证明可行:cmux 就是这么 shim `codex` 和 `claude` 的。)
 *
 * ★★作用域**只有 Forge 起的进程**:目录是每次运行现生成的、写在 runDir 下,并且只出现在我们
 *  spawn 时给的那份 env 里。不碰用户的 PATH、不碰任何全局配置 —— 用户自己开终端跑 claude,
 *  一个字节都不受影响。这条是和「往 ~/.claude/settings.json 里插 hook」最大的区别。
 *
 * ★Windows 暂不生成(需要 .cmd 包装,且路径/引号规则完全不同)—— 见 writeShimDir 的守卫。
 */

export interface ShimResult {
  /** shim 目录(要 prepend 到 PATH)。 */
  dir: string
  /** 给 agent 的额外环境变量(ZDOTDIR 等)。 */
  env: Record<string, string>
}

export interface ShimOpts {
  runDir: string
  socketPath: string
  sessionId: string
  /** 跑 shim.js 用的可执行文件。打包后是 Electron 自己(配 ELECTRON_RUN_AS_NODE=1)。 */
  nodePath: string
  /** shim 运行时脚本的绝对路径。 */
  shimJs: string
}

/**
 * 生成 shim 目录,返回它的路径。
 * ★脚本里写的全是**绝对路径**:它跑在 agent 的环境里,而那份 PATH 已经被我们改过 ——
 *  靠 `env node` 去找解释器会找到别的东西,或者干脆找不到。
 */
export function writeShimDir(opts: ShimOpts): string {
  const dir = join(opts.runDir, 'shims')
  mkdirSync(dir, { recursive: true })
  for (const cmd of SHIMMED_COMMANDS) {
    const body = [
      '#!/bin/sh',
      '# Forge 授权 shim —— 由 commandShim.ts 生成,随本次运行一起产生和消失。',
      `FORGE_AUTH_SOCK=${sh(opts.socketPath)} \\`,
      `FORGE_SESSION_ID=${sh(opts.sessionId)} \\`,
      `FORGE_SHIM_DIR=${sh(dir)} \\`,
      'ELECTRON_RUN_AS_NODE=1 \\',
      `exec ${sh(opts.nodePath)} ${sh(opts.shimJs)} ${sh(cmd)} "$@"`,
      '',
    ].join('\n')
    const f = join(dir, cmd)
    writeFileSync(f, body)
    chmodSync(f, 0o755)
  }
  writeZshDotdir(opts.runDir, dir)
  return dir
}

/**
 * ★★登录 shell 会把我们的 PATH 前缀冲掉 —— 这条是实测出来的,不是理论:
 *  macOS 的 `/etc/zprofile` 跑 `path_helper`,它按 `/etc/paths` **重建** PATH,把系统路径顶到最前面,
 *  原来的 PATH 追加在后面。实测 shim 目录从第 1 位掉到**第 13 位**,`/usr/bin` 排在它前面 ——
 *  于是真身先被找到,整层 shim 静默失效。
 *  而 codex 实际跑的就是 `/bin/zsh -lc '…'`(app-server 探针里抓到的原文),正好踩在这上面。
 *
 * 解法:`ZDOTDIR` 指向我们自己的目录。zsh 的加载顺序是
 *   /etc/zshenv → $ZDOTDIR/.zshenv → (login) /etc/zprofile → $ZDOTDIR/.zprofile → …
 * 我们的文件在 path_helper **之后**跑,所以能把 shim 目录重新顶回第一位(实测:回到第 1)。
 *
 * ★必须先 source 用户自己的那几份:ZDOTDIR 一改,用户的 ~/.zshenv / ~/.zshrc 就不会被加载了,
 *  agent 的 shell 环境会凭空少掉一堆东西(别名、nvm、代理…)。先跑用户的,再加我们这一行。
 * ★★bash 的登录 shell **没有对应机制**(它读 ~/.bash_profile,没有 ZDOTDIR 这种钩子)——
 *  所以用 bash 登录 shell 的 agent 目前不受这层保护。已知,未解。
 */
function writeZshDotdir(runDir: string, shimDir: string): void {
  const dir = join(runDir, 'zdotdir')
  mkdirSync(dir, { recursive: true })
  const line = (name: string) => [
    `# Forge —— 随本次运行生成。先把你自己的 ${name} 原样跑一遍,再把授权 shim 顶回 PATH 最前面。`,
    `[ -f "$HOME/${name}" ] && . "$HOME/${name}"`,
    // ★★**无条件** prepend,不要写「已经在 PATH 里就跳过」那种去重守卫。
    //  第一版就是那么写的,结果整层静默失效:path_helper 并不会把我们的目录删掉,它只是把它**重排**到
    //  第 13 位,于是去重守卫一看「在里面」就跳过,PATH 保持着 /usr/bin 在前的样子,真身照样先被找到。
    //  重复几个 PATH 条目毫无代价(查找取第一个命中),而少这一次 prepend 就等于这一层不存在。
    `export PATH="${shimDir}:$PATH"`,
    '',
  ].join('\n')
  // .zshenv 每一种模式都会读(登录/交互/脚本),是唯一能全覆盖的那份;
  // .zprofile / .zshrc 也写,是因为它们在 path_helper 之后跑,能纠正被重排的 PATH。
  for (const f of ['.zshenv', '.zprofile', '.zshrc']) writeFileSync(join(dir, f), line(f))
}

/** 给 agent 的额外环境变量。★和 shim 目录成对使用,少一半都不成立。 */
export function shimEnv(runDir: string, shimDir: string): Record<string, string> {
  return { ZDOTDIR: join(runDir, 'zdotdir'), FORGE_SHIM_DIR: shimDir }
}

/** 单引号包起来,内部的单引号按 POSIX 的老办法转义。路径里有空格是常态(macOS 的 Application Support)。 */
function sh(v: string): string { return `'${v.replace(/'/g, `'\\''`)}'` }

/** ★shim 目录必须在**最前面**,否则真身先被找到,这一层就白做了。 */
export function shimmedPath(shimDir: string, current: string | undefined): string {
  return current && current.length ? `${shimDir}${delimiter}${current}` : shimDir
}

/**
 * 在 PATH 里找命令的**真身**,把 shim 目录排除掉。
 * ★★不排除的话 shim 会调到自己身上 —— 无限递归,而且现场极难看懂。
 *  结尾斜杠、重复出现这些花样都得规整掉再比。
 */
export function realBinaryPath(
  cmd: string, shimDir: string, path: string | undefined,
  isExec: (p: string) => boolean = canExec,
): string | null {
  const skip = resolve(shimDir)
  for (const seg of (path ?? '').split(delimiter)) {
    if (!seg) continue
    if (resolve(seg) === skip) continue
    const p = join(seg, cmd)
    if (isExec(p)) return p
  }
  return null
}

function canExec(p: string): boolean {
  try { accessSync(p, constants.X_OK); return existsSync(p) } catch { return false }
}
