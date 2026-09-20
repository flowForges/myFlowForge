import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHIMMED_COMMANDS } from '@shared/authPolicy'
import { writeShimDir, shimmedPath, realBinaryPath, shimEnv } from './commandShim'

/**
 * PATH shim 目录:Forge 在 spawn 时把它插到 PATH 最前面,agent 跑名单里的命令就先经过我们。
 *
 * ★★这一层是**唯一对 qoder / cursor / opencode / copilot 也成立**的授权入口 ——
 *  它们既没有审批协议也没有 hook。
 * ★★只对 Forge 起的进程生效:目录是每次运行现生成的,写在 runDir 下,不碰用户的 PATH、
 *  不碰任何全局配置。用户自己开终端跑 claude,一个字节都不受影响。
 */
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shim-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = () => writeShimDir({ runDir: dir, socketPath: join(dir, 'a.sock'), sessionId: 's1', nodePath: '/usr/local/bin/node', shimJs: '/app/shim.js' })

describe('生成 shim 目录', () => {
  it('★名单里每个命令都有一个可执行的同名文件', () => {
    const d = write()
    for (const c of SHIMMED_COMMANDS) {
      const f = join(d, c)
      expect(existsSync(f), `缺 ${c}`).toBe(true)
      expect(statSync(f).mode & 0o111, `${c} 不可执行`).toBeGreaterThan(0)
    }
  })

  it('★★脚本里写的是**绝对路径** —— 它跑在 agent 的环境里,PATH 已经被我们改过,靠 env 找 node 会找不到', () => {
    const body = readFileSync(join(write(), 'git'), 'utf8')
    expect(body).toContain('/usr/local/bin/node')
    expect(body).toContain('/app/shim.js')
    expect(body, '不能靠 PATH 上的 node').not.toMatch(/env node|^node /m)
  })

  it('★把命令名传给 shim —— 一个 shim.js 服务所有命令,靠这个参数知道自己扮演谁', () => {
    expect(readFileSync(join(write(), 'kubectl'), 'utf8')).toContain('kubectl')
  })

  it('★socket 和会话 id 也要带上,不然中枢不知道该在哪个会话里弹卡', () => {
    const body = readFileSync(join(write(), 'git'), 'utf8')
    expect(body).toContain('a.sock')
    expect(body).toContain('s1')
  })

  it('目录里没有别的东西 —— 多一个文件就是多劫持一条命令', () => {
    expect(readdirSync(write()).sort()).toEqual([...SHIMMED_COMMANDS].sort())
  })
})

describe('shimmedPath', () => {
  it('★★shim 目录必须在**最前面**,否则真实命令先被找到,整层白做', () => {
    expect(shimmedPath('/shims', '/usr/bin:/bin')).toBe('/shims:/usr/bin:/bin')
  })
  it('原来的 PATH 一个字节都不能丢', () => {
    expect(shimmedPath('/shims', '/a:/b:/c')).toContain('/a:/b:/c')
  })
  it('PATH 是空的也不能生成一个带空段的 PATH', () => {
    expect(shimmedPath('/shims', '')).toBe('/shims')
    expect(shimmedPath('/shims', undefined)).toBe('/shims')
  })
})

describe('realBinaryPath', () => {
  it('★★找真身时必须把 shim 目录**排除掉** —— 否则 shim 调到自己身上,无限递归', () => {
    expect(realBinaryPath('git', '/shims', '/shims:/usr/bin:/bin', (p) => p === '/usr/bin/git')).toBe('/usr/bin/git')
  })
  it('★同名目录的花样也要排掉(结尾斜杠 / 重复出现)', () => {
    expect(realBinaryPath('git', '/shims', '/shims/:/shims:/bin', (p) => p === '/bin/git')).toBe('/bin/git')
  })
  it('真的没有这个命令 → null,由调用方报错,不能装作成功', () => {
    expect(realBinaryPath('git', '/shims', '/shims', () => false)).toBeNull()
  })
})

/**
 * ★★登录 shell 那一关。这是**实测**出来的坑,不是理论:macOS 的 /etc/zprofile 跑 path_helper,
 *  把 PATH 按 /etc/paths 重建,我们的 shim 目录从第 1 位掉到第 13 位 —— 整层静默失效。
 *  而 codex 实际跑的就是 `/bin/zsh -lc '…'`。
 */
describe('ZDOTDIR —— 让 shim 活过登录 shell', () => {
  it('★三个 rc 文件都要有:.zshenv 全模式生效,.zprofile/.zshrc 负责在 path_helper 之后纠正', () => {
    write()
    for (const f of ['.zshenv', '.zprofile', '.zshrc'])
      expect(existsSync(join(dir, 'zdotdir', f)), `缺 ${f}`).toBe(true)
  })

  it('★★必须先 source 用户自己的那一份 —— ZDOTDIR 一改,用户的 nvm/别名/代理全没了', () => {
    write()
    const body = readFileSync(join(dir, 'zdotdir', '.zshenv'), 'utf8')
    expect(body).toContain('$HOME/.zshenv')
    const userLine = body.indexOf('$HOME/.zshenv')
    const pathLine = body.indexOf('export PATH')
    expect(userLine, '得先跑用户的,再改 PATH').toBeLessThan(pathLine)
  })

  it('★★必须**无条件** prepend —— 「已在 PATH 里就跳过」那种守卫会让整层静默失效', () => {
    // 第一版真的这么写过,端到端一跑 which git 还是 /usr/bin/git:path_helper 不删我们的目录,
    // 它只是把它重排到第 13 位,于是去重守卫一看「在里面」就跳过,PATH 保持 /usr/bin 在前。
    // 重复几个 PATH 条目没有代价(查找取第一个命中),少这一次 prepend 就等于这层不存在。
    write()
    const body = readFileSync(join(dir, 'zdotdir', '.zshenv'), 'utf8')
    expect(body).toContain('export PATH=')
    expect(body, '又加回去重守卫了').not.toContain('case ":$PATH:"')
  })

  it('★shimEnv 和 shim 目录成对 —— 少一半都不成立', () => {
    const d = write()
    const e = shimEnv(dir, d)
    expect(e.ZDOTDIR).toBe(join(dir, 'zdotdir'))
    expect(e.FORGE_SHIM_DIR).toBe(d)
  })
})
