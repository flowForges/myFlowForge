import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bwrapArgs, ensureGitHooksDir, execRootFor, type BwrapParams } from './bwrap'

// 真跑 bwrap(只在 Linux 且 bwrap 能起用户命名空间时;否则整个文件跳过)。探测每个文件只跑一次。
// 临时 HOME = cwd(最危险的情形),不碰真家目录;网络只用测试自己起的 Unix socket。
// 夹具不能放 /tmp:沙箱的 --tmpfs /tmp 会把整个夹具藏掉,隐藏与只读根的断言就都成了空话(评审 I2)。
// 放在 /var/tmp(路径短,Unix socket 路径限 108 字节);没有就退到仓库的 node_modules/.cache(已被 git 忽略)。测试后删除。
const FIXTURE_PARENT = existsSync('/var/tmp') ? '/var/tmp' : fileURLToPath(new URL('../../../../node_modules/.cache/', import.meta.url))

function probe(net: boolean): boolean {
  if (process.platform !== 'linux') return false
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-user', '--unshare-pid', ...(net ? ['--unshare-net'] : []), '--die-with-parent', '/bin/true']
  const r = spawnSync('bwrap', args, { stdio: 'ignore', timeout: 5_000 })
  return r.status === 0
}
const hasBwrap = probe(false)
const hasNetns = hasBwrap && probe(true)

let R = ''
let home = ''
let data = ''
let tmp = ''
let spill = ''
let outside = ''
let sockDir = ''
let sock = ''
let server: Server | undefined
let runDir = ''
let agent = ''
const hostServers: Server[] = []

beforeAll(async () => {
  if (!hasBwrap) return
  mkdirSync(FIXTURE_PARENT, { recursive: true })
  R = mkdtempSync(join(FIXTURE_PARENT, 'mffai-bwrap-'))
  home = join(R, 'home')
  data = join(R, 'data')
  tmp = join(data, 'sessions', 's', 'tmp')
  spill = join(data, 'sessions', 's', 'spill')
  outside = join(R, 'outside')
  for (const d of [join(home, '.ssh'), join(home, '.git'), tmp, spill, outside]) mkdirSync(d, { recursive: true })
  writeFileSync(join(home, '.ssh', 'id'), 'SECRET')
  writeFileSync(join(home, '.npmrc'), 'SECRET')
  writeFileSync(join(home, '.zshrc'), '# rc\n')
  writeFileSync(join(home, '.git', 'config'), '[core]\n')
  writeFileSync(join(data, 'token'), 'SECRET')
  ensureGitHooksDir(join(home, '.git'))
  // 假的运行时目录(会话总线)与 ssh-agent:宿主上真有服务在听,沙箱里必须连不上
  runDir = join(R, 'run')
  mkdirSync(runDir)
  agent = join(R, 'agent.sock')
  for (const path of [join(runDir, 'bus'), agent]) {
    const s = createServer(c => { c.on('error', () => {}); c.end('LEAK') })
    await new Promise<void>(r => s.listen(path, r))
    hostServers.push(s)
  }
  if (hasNetns) {
    sockDir = mkdtempSync(join(tmpdir(), 'mffai-net-'))
    sock = join(sockDir, 'net.sock')
    server = createServer(c => { c.on('error', () => {}); c.on('data', d => c.end(`echo:${d}`)) })
    await new Promise<void>(r => server!.listen(sock, r))
  }
})

afterAll(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  for (const s of hostServers) await new Promise<void>(r => s.close(() => r()))
  if (sockDir) rmSync(sockDir, { recursive: true, force: true })
  if (R) rmSync(R, { recursive: true, force: true })
})

function params(over: Partial<BwrapParams>): BwrapParams {
  return {
    level: 'partial',
    cwd: home,
    tmp,
    spill,
    gitDirs: [join(home, '.git')],
    gitProtected: [],
    hideDirs: [join(home, '.ssh')],
    hideFiles: [join(home, '.npmrc')],
    dataDir: data,
    persistence: [join(home, '.zshrc')],
    execPath: process.execPath,
    execRoot: execRootFor(process.execPath),
    command: 'true',
    env: fakeEnv(),
    ...over,
  }
}

function fakeEnv() {
  return { PATH: process.env.PATH, HOME: home, NODE: process.execPath, XDG_RUNTIME_DIR: runDir, SSH_AUTH_SOCK: agent, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runDir, 'bus')}` }
}

function run(p: BwrapParams) {
  const r = spawnSync('bwrap', bwrapArgs(p), {
    env: { ...fakeEnv(), ELECTRON_RUN_AS_NODE: '1', DOCKER_HOST: 'unix:///x' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe.skipIf(!hasBwrap)('bwrap (real)', () => {
  it('credentials and the data dir read as empty / missing', () => {
    const r = run(params({ command: 'cat "$HOME/.ssh/id"; cat "$HOME/.npmrc"; ls "$HOME/.ssh"' }))
    expect(r.out).not.toContain('SECRET')
    const r2 = run(params({ command: `cat ${JSON.stringify(join(data, 'token'))}` }))
    expect(r2.code).not.toBe(0)
    expect(r2.out).not.toContain('SECRET')
  })

  it('writing outside cwd fails; cwd and tmp are writable; spill is read-only', () => {
    const r = run(params({ command: 'echo x > ../outside/f' }))
    expect(r.code).not.toBe(0)
    expect(r.err).toMatch(/Read-only file system/)
    expect(existsSync(join(outside, 'f'))).toBe(false)
    expect(run(params({ command: 'echo x > ../f' })).code).not.toBe(0)
    expect(existsSync(join(R, 'f'))).toBe(false)
    expect(run(params({ command: `echo y > ${JSON.stringify(join(spill, 'f'))}` })).code).not.toBe(0)
    expect(existsSync(join(spill, 'f'))).toBe(false)
    expect(run(params({ command: `echo in > in.txt && echo t > ${JSON.stringify(join(tmp, 't'))}` })).code).toBe(0)
    expect(readFileSync(join(home, 'in.txt'), 'utf8')).toBe('in\n')
    expect(readFileSync(join(tmp, 't'), 'utf8')).toBe('t\n')
  })

  it('git hooks / config, persistence files and the gitDir rename are blocked', () => {
    expect(run(params({ command: 'echo x > .git/hooks/pre-commit' })).code).not.toBe(0)
    expect(existsSync(join(home, '.git', 'hooks', 'pre-commit'))).toBe(false)
    expect(run(params({ command: 'echo x >> .git/config' })).code).not.toBe(0)
    expect(run(params({ command: 'mv .git .g' })).code).not.toBe(0)
    expect(existsSync(join(home, '.git'))).toBe(true)
    expect(run(params({ command: 'echo x >> .zshrc' })).code).not.toBe(0)
    expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('# rc\n')
    expect(run(params({ command: 'cat .zshrc' })).out).toBe('# rc\n')
  })

  it('the shell never sees ELECTRON_RUN_AS_NODE or the agent / bus / docker variables', () => {
    expect(run(params({ command: 'echo "[${ELECTRON_RUN_AS_NODE-unset}${SSH_AUTH_SOCK-}${DBUS_SESSION_BUS_ADDRESS-}${DOCKER_HOST-}]"' })).out).toBe('[unset]\n')
  })

  it('host unix sockets (runtime dir, ssh-agent) are unreachable', () => {
    for (const path of [join(runDir, 'bus'), agent]) {
      const js = `const s=require("net").connect(${JSON.stringify(path)});s.on("error",e=>process.stdout.write("err:"+e.code));s.on("data",d=>process.stdout.write(String(d)))`
      const r = run(params({ command: `"$NODE" -e '${js}'` }))
      expect(r.out, path).not.toContain('LEAK')
      expect(r.out, path).toMatch(/^err:/)
    }
  })

  it.skipIf(!hasNetns)('full: the relay reaches the bound proxy socket, nothing else; exit code passes through', () => {
    const client = `"$NODE" -e 'const s=require("net").connect(3128,"127.0.0.1");s.on("error",e=>process.stdout.write("err:"+e.code));s.end("ping");let b="";s.on("data",d=>b+=d);s.on("close",()=>process.stdout.write("got["+b+"]"))'`
    const r = run(params({ level: 'full', unixSock: sock, command: `${client}; echo; echo "[\${ELECTRON_RUN_AS_NODE-unset}]"; exit 7` }))
    expect(r.out).toBe('got[echo:ping]\n[unset]\n')
    expect(r.code).toBe(7)
    // 宿主上的 socket 目录在沙箱里看不到别的东西
    expect(run(params({ level: 'full', unixSock: sock, command: `ls ${JSON.stringify(sockDir)}` })).out).toBe('net.sock\n')
  })
})
