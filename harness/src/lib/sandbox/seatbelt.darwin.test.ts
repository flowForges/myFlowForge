import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sandboxExecArgs, seatbeltProfile, type SeatbeltParams } from './seatbelt'

// 真跑 /usr/bin/sandbox-exec(还没有内核):临时 HOME / 数据目录 / git 仓库,不碰真家目录、不碰真网络
// (服务器都是测试自己在回环上起的;"外网"只用本机网卡地址上没人监听的端口,包根本出不了本机)。
// 测试进程自己在沙箱里时不能嵌套(sandbox_apply 退出 71)→ 整个文件跳过。探测每个文件只跑一次。

function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') return false
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' })
  return r.status === 0
}
const usable = sandboxExecUsable()

// 故意用 os.tmpdir() 的原样拼写(/var/folders/…,realpath 是 /private/var/…),顺带验证两种拼写都生效
let R = ''
let home = ''
let cwd = ''
let tmp = ''
let spill = ''
let data = ''
let probe = ''
let base: SeatbeltParams
let profile = ''
let env: NodeJS.ProcessEnv = {}
const servers: Server[] = []
const children: ChildProcess[] = []
let udp: UdpSocket | undefined
const udpSeen: Buffer[] = []
let udpPort = 0
let allowedPort = 0
let deniedPort = 0
let v6Port = 0
let unixPath = ''
const slashTmpProbe = `/tmp/mffai-sbx-probe-${process.pid}-${Date.now()}`
const launchLabel = `mffai.sbxtest.${process.pid}.${Date.now()}`
const node = JSON.stringify(process.execPath)
const q = (s: string) => JSON.stringify(s)

/** 本机一个非回环地址(包不出本机);没有就跳过相关断言 */
const lanIp = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address

function listen(s: Server, host: string, arg: number | string = 0): Promise<number> {
  servers.push(s)
  return new Promise((res, rej) => {
    s.once('error', rej)
    const done = () => res(typeof s.address() === 'object' ? (s.address() as { port: number }).port : 0)
    if (typeof arg === 'string') s.listen(arg, done)
    else s.listen(arg, host, done)
  })
}

type Run = { code: number | null; out: string; err: string }

function collect(c: ChildProcess): Promise<Run> {
  return new Promise((res, rej) => {
    let out = ''
    let err = ''
    c.stdout?.on('data', d => { out += d })
    c.stderr?.on('data', d => { err += d })
    c.on('error', rej)
    c.on('close', code => res({ code, out, err }))
  })
}

/** 沙箱外跑(建夹具、对照组) */
const sh = (cmd: string, dir = cwd) => collect(spawn('/bin/sh', ['-c', cmd], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] }))

/** 沙箱里跑 */
function boxed(cmd: string, o: { profile?: string; cwd?: string } = {}): Promise<Run> {
  const { file, args } = sandboxExecArgs(o.profile ?? profile, cmd)
  return collect(spawn(file, args, { cwd: o.cwd ?? cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }))
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const pgrep = (name: string) => (spawnSync('/usr/bin/pgrep', ['-x', name], { encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean).map(Number)
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

const PROBE_JS = `
const net = require('net'), [, , mode, ...a] = process.argv
const out = s => { process.stdout.write(s + '\\n'); process.exit(0) }
const conn = (host, port) => new Promise(r => {
  const s = net.connect(+port, host); let d = ''
  s.on('data', x => { d += x }); s.on('end', () => r(d.trim() || 'EMPTY'))
  s.on('error', e => r('ERR ' + e.code)); setTimeout(() => { s.destroy(); r('TIMEOUT') }, 3000)
})
;(async () => {
  if (mode === 'connect') out(await conn(a[0], a[1]))
  if (mode === 'unix') {
    const s = net.connect(a[0]); s.on('data', d => out(String(d).trim())); s.on('error', e => out('ERR ' + e.code))
  }
  if (mode === 'serve') {
    const srv = net.createServer(s => s.end('SELF'))
    srv.on('error', e => out('ERR ' + e.code))
    srv.listen(0, a[0], async () => { out(await conn(a[0], srv.address().port)); srv.close() })
  }
  if (mode === 'dns') {
    const r = new (require('dns').Resolver)({ timeout: 500, tries: 1 })
    r.setServers([a[0]])
    r.resolve4('mffai-probe.test', (e, x) => out(e ? 'ERR ' + e.code : 'ADDR ' + x))
  }
})()
`

describe.skipIf(!usable)('seatbelt (real sandbox-exec)', () => {
  beforeAll(async () => {
    R = mkdtempSync(join(tmpdir(), 'mffai-sbx-'))
    home = join(R, 'home')
    cwd = join(R, 'cwd')
    data = join(R, 'data')
    tmp = join(data, 'sessions', 's1', 'tmp')
    spill = join(data, 'sessions', 's1', 'spill')
    for (const d of [join(home, '.ssh'), join(R, 'outside'), cwd, tmp, spill, join(cwd, 'h', '.ssh')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(home, '.ssh', 'id'), 'SECRET\n')
    writeFileSync(join(home, '.zshrc'), '# rc\n')
    writeFileSync(join(cwd, 'h', '.ssh', 'id'), 'SECRET2\n')
    writeFileSync(join(cwd, 'h', '.zshrc'), '# hrc\n') // cwd 里的假家目录:持久化文件(存在)与 .aws(不存在)
    writeFileSync(join(data, 'token'), 'DATATOKEN\n')
    writeFileSync(join(spill, 'out.txt'), 'SPILLED\n')
    writeFileSync(join(R, 'gitconfig'), '')
    probe = join(R, 'probe.js')
    writeFileSync(probe, PROBE_JS)
    symlinkSync(join(home, '.ssh'), join(cwd, 'link'))

    env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TMPDIR: tmp,
      LC_ALL: 'C',
      PYTHONDONTWRITEBYTECODE: '1',
      GIT_CONFIG_GLOBAL: join(R, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    }
    const init = await sh('git init -q -b main && echo a > a.txt && git add -A && git commit -qm init'
      + ' && mkdir -p .git/worktrees/w1 .git/modules/sub/hooks'
      + ' && echo ../.. > .git/worktrees/w1/commondir && echo /x/.git > .git/worktrees/w1/gitdir && echo "[core]" > .git/modules/sub/config')
    expect(init.code, init.err).toBe(0)

    const sockDir = mkdtempSync('/tmp/mffai-sbx-u-')
    unixPath = join(sockDir, 's')
    allowedPort = await listen(createServer(s => s.end('ALLOWED\n')), '127.0.0.1')
    deniedPort = await listen(createServer(s => s.end('LOOP4\n')), '127.0.0.1')
    v6Port = await listen(createServer(s => s.end('LOOP6\n')), '::1').catch(() => 0)
    await listen(createServer(s => s.end('LEAK\n')), '', unixPath)
    udp = createSocket('udp4')
    udp.on('message', m => udpSeen.push(m))
    await new Promise<void>(r => udp!.bind(0, '127.0.0.1', () => r()))
    udpPort = udp.address().port

    const gitDir = join(cwd, '.git')
    const h = join(cwd, 'h')
    base = {
      writable: [cwd, gitDir, tmp],
      gitDirs: [gitDir],
      denyRead: [join(home, '.ssh'), join(h, '.ssh'), data],
      reAllowRead: [spill, tmp],
      denyWrite: [join(home, '.ssh'), join(h, '.ssh'), data, join(home, '.zshrc'), join(h, '.zshrc'), join(h, '.aws')],
      reAllowWrite: [tmp],
      moveBlock: [join(home, '.ssh'), join(h, '.ssh'), h, data, join(home, '.zshrc'), join(h, '.zshrc'), join(h, '.aws')],
      proxyPort: allowedPort,
    }
    profile = seatbeltProfile(base)
  })

  afterAll(async () => {
    // 子进程先死透再删目录,否则它退出时写的缓存会留下半个夹具
    await Promise.all(children.map(c => (c.exitCode !== null || c.signalCode !== null) ? undefined : new Promise(r => { c.once('exit', r); c.kill('SIGKILL') })))
    spawnSync('/bin/launchctl', ['remove', launchLabel], { stdio: 'ignore' }) // 万一 submit 成功了
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(() => r(undefined)))))
    await new Promise<void>(r => (udp ? udp.close(() => r()) : r()))
    if (unixPath) rmSync(dirname(unixPath), { recursive: true, force: true })
    rmSync(slashTmpProbe, { force: true })
    if (R) rmSync(R, { recursive: true, force: true })
  })

  // ── 文件:写 ──

  it('denies writes outside cwd', async () => {
    const r = await boxed('echo x > ../outside/f')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(R, 'outside', 'f'))).toBe(false)
  })

  it('denies writes to the shared /tmp', async () => {
    const r = await boxed(`echo x > ${slashTmpProbe}`)
    expect(r.code).not.toBe(0)
    expect(existsSync(slashTmpProbe)).toBe(false)
  })

  it('denies writes to credentials and persistence files', async () => {
    const r = await boxed('echo pwn > "$HOME/.ssh/id"; echo pwn >> "$HOME/.zshrc"; echo pwn > "$HOME/.ssh/new"')
    expect(r.code).not.toBe(0)
    expect(readFileSync(join(home, '.ssh', 'id'), 'utf8')).toBe('SECRET\n')
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('# rc\n')
    expect(existsSync(join(home, '.ssh', 'new'))).toBe(false)
  })

  it('denies case-variant writes and creation of protected paths inside cwd', async () => {
    for (const cmd of ['echo pwn >> h/.ZSHRC', 'mkdir h/.AWS', 'mkdir h/.aws', 'echo pwn > h/.SSH/new']) {
      expect((await boxed(cmd)).code, cmd).not.toBe(0)
    }
    expect(readFileSync(join(cwd, 'h', '.zshrc'), 'utf8')).toBe('# hrc\n')
    expect(existsSync(join(cwd, 'h', '.aws'))).toBe(false)
    expect(existsSync(join(cwd, 'h', '.ssh', 'new'))).toBe(false)
  })

  it('denies hardlinks to protected files (no write-through)', async () => {
    for (const [cmd, link] of [['ln .git/config cfg', 'cfg'], ['ln h/.zshrc z', 'z'], ['ln h/.ssh/id k', 'k'], ['ln "$HOME/.zshrc" hz', 'hz']]) {
      const r = await boxed(cmd)
      expect(r.code, cmd).not.toBe(0)
      expect(existsSync(join(cwd, link)), cmd).toBe(false)
    }
  })

  it('denies writes to the data dir', async () => {
    const r = await boxed(`echo x > ${q(join(data, 'new'))}; echo x >> ${q(join(data, 'token'))}; mkdir ${q(join(data, 'sessions', 's2'))}`)
    expect(r.code).not.toBe(0)
    expect(existsSync(join(data, 'new'))).toBe(false)
    expect(existsSync(join(data, 'sessions', 's2'))).toBe(false)
    expect(readFileSync(join(data, 'token'), 'utf8')).toBe('DATATOKEN\n')
  })

  it('reads spill but cannot write it; dataDir stays unreadable', async () => {
    const r = await boxed(`cat ${q(join(spill, 'out.txt'))}; cat ${q(join(data, 'token'))}; echo x > ${q(join(spill, 'w'))}`)
    expect(r.out).toContain('SPILLED')
    expect(r.out).not.toContain('DATATOKEN')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(spill, 'w'))).toBe(false)
  })

  it('writes in cwd and $TMPDIR', async () => {
    const r = await boxed('echo x > in.txt && echo y > "$TMPDIR/t"')
    expect(r.code, r.err).toBe(0)
    expect(readFileSync(join(cwd, 'in.txt'), 'utf8')).toBe('x\n')
    expect(readFileSync(join(tmp, 't'), 'utf8')).toBe('y\n')
  })

  // ── 文件:读 ──

  it('denies credential reads: direct, case variant, symlink, hardlink', async () => {
    for (const cmd of ['cat "$HOME/.ssh/id"', 'cat "$HOME/.SSH/id"', 'cat link/id']) {
      const r = await boxed(cmd)
      expect(r.code, cmd).not.toBe(0)
      expect(r.out, cmd).not.toContain('SECRET')
    }
    const hl = await boxed('ln "$HOME/.ssh/id" hl; cat hl')
    expect(hl.out).not.toContain('SECRET')
    expect(existsSync(join(cwd, 'hl'))).toBe(false)
    expect(readFileSync(join(home, '.ssh', 'id'), 'utf8')).toBe('SECRET\n')
  })

  it('a keychain file under denyRead yields nothing (client-side read)', async () => {
    const kc = '/System/Library/Keychains/SystemRootCertificates.keychain'
    if (!existsSync(kc)) return
    const outside = await sh(`/usr/bin/security find-certificate -a ${q(kc)} | grep -c keychain:`)
    expect(Number(outside.out.trim())).toBeGreaterThan(0)
    const p = seatbeltProfile({ ...base, denyRead: [...base.denyRead, kc] })
    const r = await boxed(`/usr/bin/security find-certificate -a ${q(kc)}`, { profile: p })
    expect(r.out).not.toContain('keychain:')
  })

  // ── git ──

  it('denies .git/hooks and .git/config writes', async () => {
    const before = readFileSync(join(cwd, '.git', 'config'), 'utf8')
    const r = await boxed('mkdir -p .git/hooks; echo x > .git/hooks/pre-commit')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const c = await boxed('git config core.hooksPath /x; echo "[core]" >> .git/config')
    expect(c.code).not.toBe(0)
    expect(readFileSync(join(cwd, '.git', 'config'), 'utf8')).toBe(before)
  })

  it('denies config.worktree, worktrees/*/{commondir,gitdir,config.worktree} and modules/**/{hooks,config} (SBPL regex)', async () => {
    const g = join(cwd, '.git')
    const commondir = readFileSync(join(g, 'worktrees', 'w1', 'commondir'), 'utf8')
    const gitdir = readFileSync(join(g, 'worktrees', 'w1', 'gitdir'), 'utf8')
    const modCfg = readFileSync(join(g, 'modules', 'sub', 'config'), 'utf8')
    for (const cmd of [
      'echo x > .git/config.worktree',
      'echo x >> .git/worktrees/w1/commondir',
      'echo x >> .git/worktrees/w1/gitdir',
      'echo x > .git/worktrees/w1/config.worktree',
      'echo x >> .git/modules/sub/config',
      'echo x > .git/modules/sub/hooks/pre-commit',
      'mkdir -p .git/modules/a/b && echo x > .git/modules/a/b/config',
      'mkdir -p .git/modules/a/b && mkdir .git/modules/a/b/hooks',
    ]) expect((await boxed(cmd)).code, cmd).not.toBe(0)
    expect(existsSync(join(g, 'config.worktree'))).toBe(false)
    expect(existsSync(join(g, 'worktrees', 'w1', 'config.worktree'))).toBe(false)
    expect(existsSync(join(g, 'modules', 'sub', 'hooks', 'pre-commit'))).toBe(false)
    expect(existsSync(join(g, 'modules', 'a', 'b', 'config'))).toBe(false)
    expect(existsSync(join(g, 'modules', 'a', 'b', 'hooks'))).toBe(false)
    expect(readFileSync(join(g, 'worktrees', 'w1', 'commondir'), 'utf8')).toBe(commondir)
    expect(readFileSync(join(g, 'worktrees', 'w1', 'gitdir'), 'utf8')).toBe(gitdir)
    expect(readFileSync(join(g, 'modules', 'sub', 'config'), 'utf8')).toBe(modCfg)
    // 正则不过宽:gitDir 里的普通文件照常可写
    const ok = await boxed('echo ok > .git/objects/probe-ok && echo ref > .git/worktrees/w1/HEAD && echo m > .git/modules/sub/HEAD')
    expect(ok.code, ok.err).toBe(0)
  })

  it('denies nested repos\' .git/hooks and .git/config, any case', async () => {
    for (const cmd of [
      'mkdir -p vendor/.git && mkdir vendor/.git/hooks',
      'mkdir -p vendor/.git && echo x > vendor/.git/config',
      'mkdir -p vendor/.GIT && mkdir vendor/.GIT/HOOKS',
    ]) expect((await boxed(cmd)).code, cmd).not.toBe(0)
    expect(existsSync(join(cwd, 'vendor', '.git', 'hooks'))).toBe(false)
    expect(existsSync(join(cwd, 'vendor', '.git', 'config'))).toBe(false)
  })

  it('blocks the mv .git trick', async () => {
    const r = await boxed('mv .git .g && mkdir -p .g/hooks && echo x > .g/hooks/pre-commit && mv .g .git')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(cwd, '.g'))).toBe(false)
    expect(existsSync(join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const h = await boxed('mv .git/hooks .git/h2; rm -rf .git/hooks')
    expect(h.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'hooks'))).toBe(true)
    expect(existsSync(join(cwd, '.git', 'h2'))).toBe(false)
  })

  it('blocks renaming .git/modules to plant a submodule hook (review C1)', async () => {
    const r = await boxed('mv .git/modules .git/m && echo evil > .git/m/sub/hooks/post-checkout && mv .git/m .git/modules')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'modules', 'sub', 'hooks'))).toBe(true)
    expect(existsSync(join(cwd, '.git', 'm'))).toBe(false)
    expect(existsSync(join(cwd, '.git', 'modules', 'sub', 'hooks', 'post-checkout'))).toBe(false)
    // 在别处备好带钩子的目录再挪进 modules,或换掉 modules/sub 本身,都不行
    const into = await boxed('mkdir -p .git/x/hooks && echo evil > .git/x/hooks/post-checkout && mv .git/x .git/modules/')
    expect(into.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'modules', 'x'))).toBe(false)
    const swap = await boxed('mv .git/modules/sub .git/modules/old')
    expect(swap.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'modules', 'sub', 'config'))).toBe(true)
    const nested = await boxed('mkdir -p .git/modules/sub/modules && mkdir -p .git/y/hooks && mv .git/y .git/modules/sub/modules/inner')
    expect(nested.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'modules', 'sub', 'modules', 'inner'))).toBe(false)
    await sh('rm -rf .git/x .git/y')
  })

  it('blocks renaming .git/worktrees to rewrite commondir (review C1)', async () => {
    const r = await boxed('mv .git/worktrees .git/wt && echo /evil > .git/wt/w1/commondir && mv .git/wt .git/worktrees')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'wt'))).toBe(false)
    expect(readFileSync(join(cwd, '.git', 'worktrees', 'w1', 'commondir'), 'utf8')).toBe('../..\n')
    const swap = await boxed('mkdir -p .git/z && echo /evil > .git/z/commondir && mv .git/worktrees/w1 .git/w1old; mv .git/z .git/worktrees/w2')
    expect(swap.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'w1old'))).toBe(false)
    expect(existsSync(join(cwd, '.git', 'worktrees', 'w2'))).toBe(false)
    await sh('rm -rf .git/z')
  })

  it('blocks the ancestor-rename trick', async () => {
    const r = await boxed('mv h h2 && cat h2/.ssh/id')
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('SECRET2')
    expect(existsSync(join(cwd, 'h', '.ssh', 'id'))).toBe(true)
    expect(existsSync(join(cwd, 'h2'))).toBe(false)
  })

  it('git commit works (the git dir is writable)', async () => {
    const r = await boxed('echo c > c.txt && git add -A && git commit -qm t && git rev-list --count HEAD')
    expect(r.code, r.err).toBe(0)
    expect(r.out.trim()).toBe('2')
  })

  it('separate git dir (not named .git): hooks, config and the cwd .git file are protected, commit works', async () => {
    const wt = join(R, 'wt')
    const gd = join(R, 'gd')
    mkdirSync(wt)
    const init = await sh(`git init -q -b main --separate-git-dir=${q(gd)} && echo a > a.txt && git add -A && git commit -qm init && rm -rf ${q(join(gd, 'hooks'))}`, wt)
    expect(init.code, init.err).toBe(0)
    const gitFile = readFileSync(join(wt, '.git'), 'utf8')
    const cfg = readFileSync(join(gd, 'config'), 'utf8')
    const p = seatbeltProfile({
      writable: [wt, gd, tmp], gitDirs: [gd], cwdGitFile: join(wt, '.git'),
      denyRead: [], reAllowRead: [], denyWrite: [], reAllowWrite: [tmp], moveBlock: [],
    })
    const run = async (cmd: string) => (await boxed(cmd, { profile: p, cwd: wt })).code
    // hooks 不存在时也建不出来,换大小写也不行
    expect(await run(`mkdir -p ${q(join(gd, 'hooks'))}; echo x > ${q(join(gd, 'hooks', 'pre-commit'))}`)).not.toBe(0)
    expect(await run(`mkdir ${q(join(gd, 'HOOKS'))}`)).not.toBe(0)
    expect(existsSync(join(gd, 'hooks'))).toBe(false)
    expect(await run(`echo "[core]" >> ${q(join(gd, 'config'))}`)).not.toBe(0)
    expect(await run(`echo "[core]" >> ${q(join(gd, 'CONFIG'))}`)).not.toBe(0)
    expect(readFileSync(join(gd, 'config'), 'utf8')).toBe(cfg)
    expect(await run('echo "gitdir: /elsewhere" > .git')).not.toBe(0)
    expect(await run('mv .git g2')).not.toBe(0)
    expect(await run('rm -f .git')).not.toBe(0)
    expect(readFileSync(join(wt, '.git'), 'utf8')).toBe(gitFile)
    expect(await run('echo b > b.txt && git add -A && git commit -qm t')).toBe(0)
  })

  // ── 运行时 ──

  it('node, npm and python3 (incl. multiprocessing and shared_memory) run (R1 revised: sysctl list)', async () => {
    const n = await boxed(`${node} -e "const os=require('os');os.userInfo();os.cpus();if(!Object.keys(os.networkInterfaces()).includes('lo0'))throw new Error('no lo0');require('crypto').randomBytes(8);require('tls');require('child_process').execSync('true');process.stdout.write('ok')"`)
    expect(n.code, n.err).toBe(0)
    expect(n.out).toBe('ok')
    const z = await boxed(`${node} -e 1`)
    expect(z.code, z.err).toBe(0)
    const npm = join(dirname(process.execPath), 'npm')
    if (existsSync(npm)) {
      mkdirSync(join(cwd, 'npmprobe'), { recursive: true })
      const m = await boxed(`cd npmprobe && npm_config_cache="$TMPDIR/npmc" ${q(npm)} init -y >/dev/null && echo ok`)
      expect(m.code, m.err).toBe(0)
    }
    if ((await sh('python3 -c "print(1)"')).code !== 0) return
    const py = await boxed(`python3 -c "
import multiprocessing as mp, getpass, ssl, socket
from multiprocessing import shared_memory
if __name__ == '__main__':
    getpass.getuser()
    assert socket.if_nameindex()
    mp.Lock().acquire()
    with mp.Pool(2) as p: assert p.map(abs, [-1, -2]) == [1, 2]
    m = shared_memory.SharedMemory(create=True, size=16); m.buf[0] = 7; m.close(); m.unlink()
    print('ok')"`)
    expect(py.code, py.err).toBe(0)
    expect(py.out.trim()).toBe('ok')
  })

  it('cannot read shared memory created outside the sandbox (I1)', async () => {
    if ((await sh('python3 -c "print(1)"')).code !== 0) return
    const name = `mffai_probe_${process.pid}`
    // 沙箱外的进程建一块命名共享内存并一直持有,stdin 关掉时自己 unlink
    const holder = spawn('python3', ['-c', `
import sys
from multiprocessing import shared_memory
m = shared_memory.SharedMemory(name=${JSON.stringify(name)}, create=True, size=16)
m.buf[:9] = b'SHMSECRET'
print('ready', flush=True)
sys.stdin.read()
m.close(); m.unlink()`], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    children.push(holder)
    await new Promise<void>(r => holder.stdout!.once('data', () => r()))
    try {
      // 读者直接 shm_open + mmap:用 SharedMemory 打开会被 resource_tracker 在退出时 unlink,对照组会把它删掉
      const read = `python3 -c "
import _posixshmem, mmap, os
try:
    fd = _posixshmem.shm_open('/${name}', os.O_RDONLY, 0); print(mmap.mmap(fd, 16, prot=mmap.PROT_READ)[:9])
except Exception as e: print('ERR', type(e).__name__)"`
      expect((await sh(read)).out).toContain('SHMSECRET') // 对照:沙箱外读得到
      const r = await boxed(read)
      expect(r.out).not.toContain('SHMSECRET')
      expect(r.out).toContain('ERR PermissionError')
      expect((await sh(read)).out).toContain('SHMSECRET') // 还在:拒绝不是因为它没了
    } finally {
      const exited = new Promise(r => holder.once('exit', r))
      holder.stdin!.end()
      await exited
    }
  })

  it('cannot list the process table or signal / inspect an outside process', async () => {
    const sleeper = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    children.push(sleeper)
    const pid = sleeper.pid!
    const r = await boxed(`kill -TERM ${pid}; echo kill=$?; ps -p ${pid} -o command=; echo ps=$?`)
    expect(r.out).toMatch(/kill=[1-9]/)
    expect(r.out).not.toContain('sleep 60')
    expect(alive(pid)).toBe(true)
    if ((await sh('python3 -c "print(1)"')).code !== 0) return
    // sysctl {CTL_KERN, KERN_PROC, KERN_PROC_ALL} 拒;查自己的 pid 仍可
    // n = 3:{CTL_KERN, KERN_PROC, KERN_PROC_ALL};n = 4:{…, KERN_PROC_PID, 自己}。只取大小,不读内容
    const py = (mib: string, n: number) => `python3 -c "
import ctypes, ctypes.util, os
l = ctypes.CDLL(ctypes.util.find_library('c'))
mib = (ctypes.c_int*4)(${mib}); sz = ctypes.c_size_t(0)
print('rc', l.sysctl(mib, ${n}, None, ctypes.byref(sz), None, 0))"`
    expect((await sh(py('1,14,0,0', 3))).out.trim()).toBe('rc 0') // 对照
    expect((await boxed(py('1,14,0,0', 3))).out.trim()).toBe('rc -1')
    expect((await boxed(py('1,14,1,os.getpid()', 4))).out.trim()).toBe('rc 0')
  })

  // ── 逃逸到别的服务 ──

  it('open -a Calculator is denied by LaunchServices, and no Calculator starts', async () => {
    const before = new Set(pgrep('Calculator'))
    try {
      const r = await boxed('open -a Calculator')
      expect(r.code).not.toBe(0)
      // 应用确实在:"找不到应用"只能是 LaunchServices 被拒
      if (existsSync('/System/Applications/Calculator.app')) expect(r.err).toContain('Unable to find application')
      await delay(300)
      expect(pgrep('Calculator').filter(p => !before.has(p))).toEqual([])
    } finally {
      for (const p of pgrep('Calculator')) if (!before.has(p)) try { process.kill(p, 'SIGKILL') } catch { /* gone */ }
    }
  })

  it('launchctl submit is refused', async () => {
    const marker = join(cwd, 'launch-marker')
    const r = await boxed(`/bin/launchctl submit -l ${launchLabel} -- /usr/bin/touch ${q(marker)}`)
    expect(r.code).not.toBe(0)
    await delay(500)
    expect(existsSync(marker)).toBe(false)
    expect(spawnSync('/bin/launchctl', ['list', launchLabel], { stdio: 'ignore' }).status).not.toBe(0)
  })

  // ── 网络 ──

  it('network: only the proxy port; other ports, ::1, LAN, unix sockets, DNS and listening fail', async () => {
    const c = (host: string, port: number) => boxed(`${node} ${q(probe)} connect ${host} ${port}`)
    expect((await c('127.0.0.1', allowedPort)).out).toContain('ALLOWED')
    const bad = await c('127.0.0.1', deniedPort)
    expect(bad.out).not.toContain('LOOP4')
    expect(bad.out).toMatch(/ERR EPERM/)
    if (v6Port) {
      const v6 = await c('::1', v6Port)
      expect(v6.out).not.toContain('LOOP6')
      expect(v6.out).toMatch(/ERR EPERM/)
    }
    if (lanIp) expect((await c(lanIp, deniedPort)).out).toMatch(/ERR EPERM/)
    const ux = await boxed(`${node} ${q(probe)} unix ${q(unixPath)}`)
    expect(ux.out).not.toContain('LEAK')
    expect(ux.out).toContain('ERR')
    expect((await boxed(`${node} ${q(probe)} serve 127.0.0.1`)).out).not.toContain('SELF')
    // DNS:向测试自己的回环"域名服务器"查询 —— 对照组能到,沙箱里一个包都到不了
    const dnsArgs = `${node} ${q(probe)} dns 127.0.0.1:${udpPort}`
    await sh(dnsArgs)
    expect(udpSeen.length).toBeGreaterThan(0)
    udpSeen.length = 0
    const d = await boxed(dnsArgs)
    expect(d.out).toContain('ERR')
    await delay(100)
    expect(udpSeen).toEqual([])
  })

  it('allowLoopback (R6): listen, 127.0.0.1 and ::1 work; non-local still EPERM; off by default', async () => {
    const p = seatbeltProfile({ ...base, allowLoopback: true })
    const c = (host: string, port: number) => boxed(`${node} ${q(probe)} connect ${host} ${port}`, { profile: p })
    expect((await boxed(`${node} ${q(probe)} serve 127.0.0.1`, { profile: p })).out).toContain('SELF')
    expect((await c('127.0.0.1', deniedPort)).out).toContain('LOOP4')
    expect((await c('127.0.0.1', allowedPort)).out).toContain('ALLOWED')
    if (v6Port) expect((await c('::1', v6Port)).out).toContain('LOOP6')
    // 非本机地址仍拒。用多播地址:沙箱外 TCP 连它是 EAFNOSUPPORT,一个包都不发;沙箱里在那之前就 EPERM。
    // (实测:Seatbelt 的 localhost 也包括本机网卡地址,所以 lanIp 在这里是通的,不能当"外网"用)
    expect((await sh(`${node} ${q(probe)} connect 224.0.0.1 9`)).out).toMatch(/ERR EAFNOSUPPORT/)
    expect((await c('224.0.0.1', 9)).out).toMatch(/ERR EPERM/)
    // 默认关:同样的请求被拒
    expect((await boxed(`${node} ${q(probe)} connect 127.0.0.1 ${deniedPort}`)).out).toMatch(/ERR EPERM/)
  })

  // ── 转义 ──

  it('a path with quotes, backslashes and parens is matched exactly', async () => {
    const odd = join(R, 'q"u\\o(t)e; x')
    mkdirSync(odd)
    const p = seatbeltProfile({ writable: [odd], gitDirs: [], denyRead: [], reAllowRead: [], denyWrite: [], reAllowWrite: [], moveBlock: [] })
    expect((await boxed('echo x > f', { profile: p, cwd: odd })).code).toBe(0)
    expect(existsSync(join(odd, 'f'))).toBe(true)
    // 只放了这一个目录:兄弟目录不可写
    expect((await boxed('echo x > ../outside/g', { profile: p, cwd: odd })).code).not.toBe(0)
    expect(existsSync(join(R, 'outside', 'g'))).toBe(false)
  })
})
