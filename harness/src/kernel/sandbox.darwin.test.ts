// 真跑 sandbox-exec:内核 sandbox 服务生成的配置能挡住替换子模块 git 目录的手法(re-review C1)。
// 临时 HOME / 数据目录 / 仓库;测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SandboxService } from '../lib/tools/types'
import { createSandboxService } from './sandbox'

function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') return false
  return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
}
const usable = sandboxExecUsable()

let root = ''
let home = ''
let repo = ''
let lib = ''
let logs = ''
let svc: SandboxService

describe.skipIf(!usable)('kernel sandbox, real sandbox-exec: submodule git dirs', () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-sbxk-')))
    home = join(root, 'home')
    repo = join(home, 'repo')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repo, '.git', 'config'), '[core]\n')
    mkdirSync(join(repo, '.git', 'objects'))
    // 名字带 `/` 的子模块:git 目录在 .git/modules/vendor/lib
    lib = join(repo, '.git', 'modules', 'vendor', 'lib')
    mkdirSync(join(lib, 'objects'), { recursive: true })
    mkdirSync(join(lib, 'hooks'))
    writeFileSync(join(lib, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(lib, 'config'), '[core]\n')
    // 名为 vendor/logs 的子模块(final review I1):logs 不在已认出的 git 目录里,不能被当成内部目录跳过
    logs = join(repo, '.git', 'modules', 'vendor', 'logs')
    mkdirSync(join(logs, 'objects'), { recursive: true })
    mkdirSync(join(logs, 'hooks'))
    writeFileSync(join(logs, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(logs, 'config'), '[core]\n')
    const missingGit = (async () => { throw new Error('no git in this test') }) as never // 走目录兜底,不需要真的 git
    svc = createSandboxService({
      platform: 'darwin', dataDir: join(root, 'data'), home, env: { HOME: home }, detected: { level: 'full', missing: [] },
      permissions: () => ({ rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }),
      rules: () => [], append: () => {}, git: missingGit,
    })
  })
  afterAll(async () => {
    await svc?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })

  async function boxed(cmd: string): Promise<{ code: number | null; err: string }> {
    const p = await svc.plan(cmd, { sessionId: 's1', cwd: repo, spillDir: join(root, 'data', 'sessions', 's1', 'spill') }, { PATH: '/usr/bin:/bin', HOME: home })
    try {
      return await new Promise((resolve, reject) => {
        const c = spawn(p.file, p.args, { cwd: repo, env: p.env, stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        c.stderr!.on('data', d => { err += d })
        c.on('error', reject)
        c.on('close', code => resolve({ code, err }))
      })
    } finally {
      p.release()
    }
  }

  it('swapping .git/modules/vendor/lib for a prepared dir with a hook is denied', async () => {
    const r = await boxed('mkdir -p .git/y/hooks && echo evil > .git/y/hooks/post-checkout && cp .git/modules/vendor/lib/HEAD .git/y/'
      + ' && mv .git/modules/vendor/lib .git/lib.bak && mv .git/y .git/modules/vendor/lib')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(repo, '.git', 'lib.bak'))).toBe(false)
    expect(existsSync(join(lib, 'hooks', 'post-checkout'))).toBe(false)
    expect(readFileSync(join(lib, 'config'), 'utf8')).toBe('[core]\n')
  })

  it('pre-created fake HEAD/objects on the dir in between do not hide the real module: the swap is still denied (re-review R2)', async () => {
    const pre = await boxed('echo "ref: refs/heads/x" > .git/modules/vendor/HEAD && mkdir -p .git/modules/vendor/objects')
    expect(pre.code, pre.err).toBe(0) // 能伪造(HEAD / objects 不受保护)
    const r = await boxed('mkdir -p .git/y/hooks && echo evil > .git/y/hooks/post-checkout && cp .git/modules/vendor/lib/HEAD .git/y/'
      + ' && mv .git/modules/vendor/lib .git/lib.bak && mv .git/y .git/modules/vendor/lib')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(repo, '.git', 'lib.bak'))).toBe(false)
    expect(existsSync(join(lib, 'hooks', 'post-checkout'))).toBe(false)
    // 伪造 config 来"认领"中间目录也不行
    expect((await boxed('echo "[core]" > .git/modules/vendor/config')).code).not.toBe(0)
    rmSync(join(repo, '.git', 'modules', 'vendor', 'HEAD'), { force: true })
    rmSync(join(repo, '.git', 'modules', 'vendor', 'objects'), { recursive: true, force: true })
    rmSync(join(repo, '.git', 'y'), { recursive: true, force: true })
  })

  it('renaming or deleting the module dir, or the dir between it and modules, is denied', async () => {
    expect((await boxed('mv .git/modules/vendor/lib .git/modules/vendor/old')).code).not.toBe(0)
    expect((await boxed('mv .git/modules/vendor .git/modules/v2')).code).not.toBe(0)
    // rm -rf 能删掉 HEAD(git 要写它),目录本身与 config 删不掉;之后仍认得出、仍挡改名
    expect((await boxed('rm -rf .git/modules/vendor')).code).not.toBe(0)
    expect(existsSync(lib)).toBe(true)
    expect(existsSync(join(lib, 'config'))).toBe(true)
    expect((await boxed('mv .git/modules/vendor/lib .git/modules/vendor/old')).code).not.toBe(0)
    expect(existsSync(lib)).toBe(true)
    writeFileSync(join(lib, 'HEAD'), 'ref: refs/heads/main\n')
    mkdirSync(join(lib, 'objects'), { recursive: true })
    mkdirSync(join(lib, 'hooks'), { recursive: true })
  })

  it('direct writes to the module hooks and config are denied; normal object writes still work', async () => {
    expect((await boxed('echo evil > .git/modules/vendor/lib/hooks/post-checkout')).code).not.toBe(0)
    expect((await boxed('echo "[core] fsmonitor = evil" >> .git/modules/vendor/lib/config')).code).not.toBe(0)
    expect(existsSync(join(lib, 'hooks', 'post-checkout'))).toBe(false)
    expect(readFileSync(join(lib, 'config'), 'utf8')).toBe('[core]\n')
    const ok = await boxed('echo x > .git/modules/vendor/lib/objects/t')
    expect(ok.code, ok.err).toBe(0)
  })

  it('a module named vendor/logs: swapping it for a dir with a hook, and direct hook / config writes, are denied (final review I1)', async () => {
    const r = await boxed('mv .git/modules/vendor/logs .git/x && mkdir -p .git/x/hooks && echo evil > .git/x/hooks/post-checkout && mv .git/x .git/modules/vendor/logs')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(repo, '.git', 'x'))).toBe(false)
    expect(existsSync(join(logs, 'hooks', 'post-checkout'))).toBe(false)
    expect((await boxed('echo evil > .git/modules/vendor/logs/hooks/post-checkout')).code).not.toBe(0)
    expect((await boxed('echo "[core] fsmonitor = evil" >> .git/modules/vendor/logs/config')).code).not.toBe(0)
    expect(existsSync(join(logs, 'hooks', 'post-checkout'))).toBe(false)
    expect(readFileSync(join(logs, 'config'), 'utf8')).toBe('[core]\n')
  })
})
