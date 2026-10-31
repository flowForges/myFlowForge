import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sandboxExecArgs, seatbeltProfile } from './seatbelt'

// 真跑 /usr/bin/sandbox-exec(还没有内核):临时 HOME / 数据目录 / git 仓库,不碰真家目录、不碰真网络。
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
let profile = ''
let env: NodeJS.ProcessEnv = {}
const servers: Server[] = []
let allowedPort = 0
let deniedPort = 0
let unixPath = ''
const slashTmpProbe = `/tmp/mffai-sbx-probe-${process.pid}-${Date.now()}`

function listen(s: Server, arg: number | string): Promise<void> {
  servers.push(s)
  return new Promise((res, rej) => { s.once('error', rej); s.listen(arg as number, '127.0.0.1', () => res()) })
}

function listenUnix(s: Server, path: string): Promise<void> {
  servers.push(s)
  return new Promise((res, rej) => { s.once('error', rej); s.listen(path, () => res()) })
}

function sh(cmd: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res, rej) => {
    const c = spawn('/bin/sh', ['-c', cmd], { cwd: opts.cwd ?? cwd, env: opts.env ?? env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', d => { out += d })
    c.stderr.on('data', d => { err += d })
    c.on('error', rej)
    c.on('close', code => res({ code, out, err }))
  })
}

/** 在沙箱里跑一条命令 */
function boxed(cmd: string): Promise<{ code: number | null; out: string; err: string }> {
  const { file, args } = sandboxExecArgs(profile, cmd)
  return new Promise((res, rej) => {
    const c = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', d => { out += d })
    c.stderr.on('data', d => { err += d })
    c.on('error', rej)
    c.on('close', code => res({ code, out, err }))
  })
}

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
    writeFileSync(join(data, 'token'), 'DATATOKEN\n')
    writeFileSync(join(spill, 'out.txt'), 'SPILLED\n')
    writeFileSync(join(R, 'gitconfig'), '')
    symlinkSync(join(home, '.ssh'), join(cwd, 'link'))

    env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TMPDIR: tmp,
      LC_ALL: 'C',
      GIT_CONFIG_GLOBAL: join(R, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    }
    const init = await sh('git init -q -b main && echo a > a.txt && git add -A && git commit -qm init')
    expect(init.code, init.err).toBe(0)

    const sockDir = mkdtempSync('/tmp/mffai-sbx-u-')
    unixPath = join(sockDir, 's')
    await listen(createServer(s => s.end('ALLOWED\n')), 0)
    allowedPort = (servers[0].address() as { port: number }).port
    await listen(createServer(s => s.end('LEAK\n')), 0)
    deniedPort = (servers[1].address() as { port: number }).port
    await listenUnix(createServer(s => s.end('LEAK\n')), unixPath)

    const gitDir = join(cwd, '.git')
    profile = seatbeltProfile({
      writable: [cwd, gitDir, tmp],
      gitDirs: [gitDir],
      denyRead: [join(home, '.ssh'), join(cwd, 'h', '.ssh'), data],
      reAllowRead: [spill, tmp],
      denyWrite: [join(home, '.ssh'), join(cwd, 'h', '.ssh'), data, join(home, '.zshrc')],
      reAllowWrite: [tmp],
      moveBlock: [join(home, '.ssh'), join(cwd, 'h', '.ssh'), join(cwd, 'h'), data, join(home, '.zshrc')],
      proxyPort: allowedPort,
    })
  })

  afterEach(() => {
    // 万一 open 真的成功了
    spawnSync('/usr/bin/pkill', ['-x', 'Calculator'], { stdio: 'ignore' })
  })

  afterAll(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise(r => s.close(() => r(undefined)))))
    if (unixPath) rmSync(dirname(unixPath), { recursive: true, force: true })
    rmSync(slashTmpProbe, { force: true })
    if (R) rmSync(R, { recursive: true, force: true })
  })

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

  it('denies credential reads: direct, case variant, symlink, hardlink', async () => {
    for (const cmd of ['cat "$HOME/.ssh/id"', 'cat "$HOME/.SSH/id"', 'cat link/id', 'ln "$HOME/.ssh/id" hl; cat hl']) {
      const r = await boxed(cmd)
      expect(r.out, cmd).not.toContain('SECRET')
    }
    expect(readFileSync(join(home, '.ssh', 'id'), 'utf8')).toBe('SECRET\n')
  })

  it('denies writes to credentials and persistence files', async () => {
    const r = await boxed('echo pwn > "$HOME/.ssh/id"; echo pwn >> "$HOME/.zshrc"; echo pwn > "$HOME/.ssh/new"')
    expect(r.code).not.toBe(0)
    expect(readFileSync(join(home, '.ssh', 'id'), 'utf8')).toBe('SECRET\n')
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('# rc\n')
    expect(existsSync(join(home, '.ssh', 'new'))).toBe(false)
  })

  it('blocks the ancestor-rename trick', async () => {
    const r = await boxed('mv h h2 && cat h2/.ssh/id')
    expect(r.out).not.toContain('SECRET2')
    expect(existsSync(join(cwd, 'h', '.ssh', 'id'))).toBe(true)
    expect(existsSync(join(cwd, 'h2'))).toBe(false)
  })

  it('denies .git/hooks and .git/config writes', async () => {
    const before = readFileSync(join(cwd, '.git', 'config'), 'utf8')
    const r = await boxed('mkdir -p .git/hooks; echo x > .git/hooks/pre-commit')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const c = await boxed('git config core.hooksPath /x; echo "[core]" >> .git/config')
    expect(c.code).not.toBe(0)
    expect(readFileSync(join(cwd, '.git', 'config'), 'utf8')).toBe(before)
  })

  it('blocks the mv .git trick', async () => {
    const r = await boxed('mv .git .g && mkdir -p .g/hooks && echo x > .g/hooks/pre-commit && mv .g .git')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(cwd, '.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(cwd, '.g'))).toBe(false)
    expect(existsSync(join(cwd, '.git', 'hooks', 'pre-commit'))).toBe(false)
    const h = await boxed('mv .git/hooks .git/h2; rm -rf .git/hooks')
    expect(h.code).not.toBe(0)
  })

  it('reads spill but cannot write it; dataDir stays unreadable', async () => {
    const r = await boxed(`cat ${JSON.stringify(join(spill, 'out.txt'))}; cat ${JSON.stringify(join(data, 'token'))}; echo x > ${JSON.stringify(join(spill, 'w'))}`)
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

  it('git commit works (the git dir is writable)', async () => {
    const r = await boxed('echo c > c.txt && git add -A && git commit -qm t && git log --oneline | wc -l')
    expect(r.code, r.err).toBe(0)
    expect(r.out.trim()).toBe('2')
  })

  it('node and python3 run (R1: sysctl-read)', async () => {
    const n = await boxed(`${JSON.stringify(process.execPath)} -e "process.stdout.write('ok')"`)
    expect(n.code, n.err).toBe(0)
    expect(n.out).toBe('ok')
    const z = await boxed(`${JSON.stringify(process.execPath)} -e 1`)
    expect(z.code, z.err).toBe(0)
    const host = await sh('python3 -c "print(1)"')
    if (host.code === 0) {
      const p = await boxed('python3 -c "print(1)"')
      expect(p.code, p.err).toBe(0)
      expect(p.out.trim()).toBe('1')
    }
  })

  it('network: only the proxy port; other ports, unix sockets and listening fail', async () => {
    const tcp = (port: number) => `${JSON.stringify(process.execPath)} -e "const s=require('net').connect(${port},'127.0.0.1');s.on('data',d=>process.stdout.write(String(d)));s.on('error',e=>{process.stdout.write('ERR '+e.code);process.exitCode=3})"`
    const ok = await boxed(tcp(allowedPort))
    expect(ok.out).toContain('ALLOWED')
    const bad = await boxed(tcp(deniedPort))
    expect(bad.out).not.toContain('LEAK')
    expect(bad.out).toMatch(/ERR (EPERM|ECONNREFUSED|EACCES)/)
    const ux = await boxed(`${JSON.stringify(process.execPath)} -e "const s=require('net').connect('${unixPath}');s.on('data',d=>process.stdout.write(String(d)));s.on('error',e=>process.stdout.write('ERR '+e.code))"`)
    expect(ux.out).not.toContain('LEAK')
    expect(ux.out).toContain('ERR')
    const listen = await boxed(`${JSON.stringify(process.execPath)} -e "require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write('LISTENING');process.exit(0)}).on('error',e=>process.stdout.write('ERR '+e.code))"`)
    expect(listen.out).not.toContain('LISTENING')
  })

  it('open -a Calculator fails (no LaunchServices)', async () => {
    const r = await boxed('open -a Calculator')
    expect(r.code).not.toBe(0)
  })

  it('separate git dir (not named .git): hooks, config and the cwd .git file are protected, commit works', async () => {
    const wt = join(R, 'wt')
    const gd = join(R, 'gd')
    mkdirSync(wt)
    const init = await sh(`git init -q -b main --separate-git-dir=${JSON.stringify(gd)} && echo a > a.txt && git add -A && git commit -qm init`, { cwd: wt })
    expect(init.code, init.err).toBe(0)
    const gitFile = readFileSync(join(wt, '.git'), 'utf8')
    const cfg = readFileSync(join(gd, 'config'), 'utf8')
    const p = seatbeltProfile({
      writable: [wt, gd, tmp], gitDirs: [gd], cwdGitFile: join(wt, '.git'),
      denyRead: [], reAllowRead: [], denyWrite: [], reAllowWrite: [tmp], moveBlock: [],
    })
    const run = (cmd: string) => new Promise<number | null>((res, rej) => {
      const { file, args } = sandboxExecArgs(p, cmd)
      const c = spawn(file, args, { cwd: wt, env, stdio: 'ignore' })
      c.on('error', rej)
      c.on('close', res)
    })
    expect(await run(`mkdir -p ${JSON.stringify(join(gd, 'hooks'))}; echo x > ${JSON.stringify(join(gd, 'hooks', 'pre-commit'))}`)).not.toBe(0)
    expect(existsSync(join(gd, 'hooks', 'pre-commit'))).toBe(false)
    expect(await run(`echo "[core]" >> ${JSON.stringify(join(gd, 'config'))}`)).not.toBe(0)
    expect(readFileSync(join(gd, 'config'), 'utf8')).toBe(cfg)
    expect(await run('echo "gitdir: /elsewhere" > .git')).not.toBe(0)
    expect(await run('mv .git g2')).not.toBe(0)
    expect(await run('rm -f .git')).not.toBe(0)
    expect(readFileSync(join(wt, '.git'), 'utf8')).toBe(gitFile)
    expect(await run('echo b > b.txt && git add -A && git commit -qm t')).toBe(0)
  })

  it('a path with quotes, backslashes and parens is matched exactly', async () => {
    const odd = join(R, 'q"u\\o(t)e; x')
    mkdirSync(odd)
    const p = seatbeltProfile({ writable: [odd], gitDirs: [], denyRead: [], reAllowRead: [], denyWrite: [], reAllowWrite: [], moveBlock: [] })
    const run = (cmd: string) => new Promise<number | null>((res, rej) => {
      const { file, args } = sandboxExecArgs(p, cmd)
      const c = spawn(file, args, { cwd: odd, env, stdio: 'ignore' })
      c.on('error', rej)
      c.on('close', res)
    })
    expect(await run('echo x > f')).toBe(0)
    expect(existsSync(join(odd, 'f'))).toBe(true)
    // 只放了这一个目录:兄弟目录不可写
    expect(await run('echo x > ../outside/g')).not.toBe(0)
    expect(existsSync(join(R, 'outside', 'g'))).toBe(false)
  })
})
