// 真跑 sandbox-exec(04 Review Focus 2):假 qodercli 经 planExec + runCli,临时 HOME。
// 只读 / 只写的断言都带一条能成功的对照:否则"什么都干不了"也会通过。
// 测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startFakeUpstream, type FakeServer } from '../../test/fakeUpstream'
import { parseRule, type Rule } from '../lib/permissions/rules'
import { runCli } from '../lib/proc/runCli'
import type { SandboxService, ShellPlan } from '../lib/tools/types'
import { qoderAdapter } from '../plugins/executor-cli/adapters/qoder'
import { translate } from '../plugins/executor-cli/policy'
import { createSandboxService } from './sandbox'

function sandboxExecUsable(): boolean {
  if (process.platform !== 'darwin') return false
  return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0
}
const usable = sandboxExecUsable()

const FAKE = join(__dirname, '../../test/fixtures/executors/fake-cli.mjs')

let root = ''
let home = ''
let data = ''
let bin = ''
let repo = ''
let qoder = ''
let upstream: FakeServer
let svc: SandboxService
let rules: Rule[] = []
const appended: { type: string; sessionId?: string; payload: unknown }[] = []

const SID = 's1'
const session = (cwd: string) => ({ sessionId: SID, cwd, spillDir: join(data, 'sessions', SID, 'spill') })
const env = () => ({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, LC_ALL: 'C' })
const rule = (effect: 'deny' | 'ask', text: string): Rule => {
  const r = parseRule({ effect, rule: text })
  if (!('subject' in r)) throw new Error(`bad rule ${text}`)
  return r
}

let scopes = 0
interface RunOpts { cwd?: string; readOnly?: boolean; protect?: string[]; stdin?: string; keep?: (p: ShellPlan) => Promise<void> }

/** 假 CLI 在沙箱里跑一段脚本。选项与 Task 8 一样从 adapter + execPolicy + translate 来,不是手写的 */
async function cli(script: string, o: RunOpts = {}): Promise<{ code: number | null; out: string; err: string }> {
  writeFileSync(join(bin, 'scenario.json'), JSON.stringify({ run: script }))
  const cwd = o.cwd ?? repo
  const policy = svc.execPolicy(SID, cwd, 'qoder')
  const plan = await svc.planExec(join(bin, 'qodercli'), ['-p', '--output-format', 'stream-json'], session(cwd), env(), {
    allowRead: qoderAdapter.allowRead(home, {}),
    allowWrite: qoderAdapter.allowWrite(home, {}),
    allowHosts: qoderAdapter.hosts ?? [],
    proxyScope: `run_${++scopes}`,
    readOnly: o.readOnly ?? false,
    denyRead: policy.ruleDenyRead,
    denyWrite: translate(policy, o.protect).denyWrite,
  })
  expect(plan.sandboxed).toBe(true)
  let out = ''
  let err = ''
  const done = runCli(plan, {
    cwd,
    stdin: o.stdin ?? '',
    timeoutMs: 30_000,
    idleMs: 30_000,
    signal: new AbortController().signal,
    onLine: l => { out += `${l}\n` },
    onStderrLine: l => { err += `${l}\n` },
  })
  if (o.keep) await o.keep(plan)
  const r = await done
  return { code: r.code, out, err }
}

/** 同一会话的 shell 工具 */
async function shell(command: string): Promise<{ code: number | null; out: string; plan: ShellPlan }> {
  const plan = await svc.plan(command, session(repo), env())
  const r = spawnSync(plan.file, plan.args, { cwd: repo, env: plan.env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, plan }
}

function connectStatus(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: '127.0.0.1', port }, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`))
    let buf = ''
    s.on('data', d => {
      buf += d.toString()
      if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]) }
    })
    s.on('error', reject)
  })
}
const portOf = (e: NodeJS.ProcessEnv) => Number(/:(\d+)$/.exec(e.HTTPS_PROXY ?? '')?.[1])
const curlConnect = (port: number) =>
  `/usr/bin/curl -q -sS --max-time 5 -o /dev/null -w '%{http_connect}' -x http://127.0.0.1:${port} https://center.qoder.sh/ 2>/dev/null; true`

const makeService = (snapshot: Record<string, string>) =>
  createSandboxService({
    platform: 'darwin', dataDir: data, home, env: snapshot, detected: { level: 'full', missing: [] },
    permissions: () => ({ rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }),
    rules: () => rules,
    append: e => appended.push(e),
    git: (async () => { throw new Error('no git in this test') }) as never, // 走目录兜底
    upstream: { url: new URL(`http://127.0.0.1:${upstream.port}`), noProxy: () => false },
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  })

describe.skipIf(!usable)('planExec, real sandbox-exec', () => {
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-sbxe-')))
    home = join(root, 'home')
    data = join(root, 'data')
    bin = join(root, 'bin')
    repo = join(home, 'repo')
    qoder = join(home, '.qoder')
    mkdirSync(bin)
    copyFileSync(FAKE, join(bin, 'qodercli'))
    chmodSync(join(bin, 'qodercli'), 0o755)
    mkdirSync(join(repo, 'src', 'gen'), { recursive: true })
    mkdirSync(join(repo, 'hidden'))
    writeFileSync(join(repo, 'hidden', 'h.txt'), 'HIDDEN')
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh', 'id'), 'SECRET')
    for (const d of ['.auth', 'logs', 'projects', 'tmp', 'cache', '.cache', 'bin/qodercli', 'external-commands']) mkdirSync(join(qoder, d), { recursive: true })
    writeFileSync(join(qoder, '.auth', 't'), 'TOKEN\n')
    writeFileSync(join(qoder, 'settings.json'), '{}')
    writeFileSync(join(qoder, 'bin', 'qodercli', 'qodercli-1'), 'program')
    upstream = await startFakeUpstream()
    svc = makeService({ HOME: home })
  })
  afterAll(async () => {
    await svc?.close()
    await upstream?.close()
    if (root) rmSync(root, { recursive: true, force: true })
  })
  beforeEach(() => {
    rules = []
  })

  it('the fake really runs inside: stdin reaches it, and argv stays what was quoted', async () => {
    const r = await cli('cat', { stdin: "--dangerously-skip-permissions it's $HOME\n第二行" })
    expect(r.code, r.err).toBe(0)
    expect(r.out).toBe("--dangerously-skip-permissions it's $HOME\n第二行\n")
  })

  it('credentials stay hidden; the one exemption is readable and writable, and only it', async () => {
    const ssh = await cli('cat ~/.ssh/id')
    expect(ssh.code).not.toBe(0)
    expect(ssh.out + ssh.err).not.toContain('SECRET')
    const t = await cli('cat ~/.qoder/.auth/t && echo NEW > ~/.qoder/.auth/n && cat ~/.qoder/.auth/n')
    expect(t.code, t.err).toBe(0)
    expect(t.out).toBe('TOKEN\nNEW\n')
    expect(readFileSync(join(qoder, '.auth', 'n'), 'utf8')).toBe('NEW\n')
    rmSync(join(qoder, '.auth', 'n'))
  })

  it('the exemption itself can be neither moved nor replaced', async () => {
    const r = await cli('mv ~/.qoder/.auth ~/.qoder/logs/stolen')
    expect(r.code).not.toBe(0)
    expect(existsSync(join(qoder, '.auth', 't'))).toBe(true)
  })

  it('a credential root nested inside the exemption stays hidden and read-only', async () => {
    const inner = join(qoder, '.auth', 'inner')
    mkdirSync(inner)
    writeFileSync(join(inner, 'k'), 'NESTED')
    const outer = svc
    svc = makeService({ HOME: home, CODEX_HOME: inner })
    try {
      const r = await cli('cat ~/.qoder/.auth/inner/k')
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain('NESTED')
      expect((await cli('echo x > ~/.qoder/.auth/inner/w')).code).not.toBe(0)
      const ok = await cli('cat ~/.qoder/.auth/t')
      expect(ok.out).toBe('TOKEN\n')
    } finally {
      await svc.close()
      svc = outer
      rmSync(inner, { recursive: true })
    }
  })

  it('a hard link does not carry a hidden file out', async () => {
    const r = await cli('ln ~/.ssh/id ./x && cat ./x')
    expect(r.code).not.toBe(0)
    expect(r.out).not.toContain('SECRET')
    expect(existsSync(join(repo, 'x'))).toBe(false)
  })

  it('writes: cwd and the six subdirectories yes, anywhere else no', async () => {
    const ok = await cli('echo x > ./w.txt && for d in .auth logs projects tmp cache .cache; do echo x > ~/.qoder/$d/w || exit 1; done')
    expect(ok.code, ok.err).toBe(0)
    rmSync(join(repo, 'w.txt'))
    for (const d of ['.auth', 'logs', 'projects', 'tmp', 'cache', '.cache']) rmSync(join(qoder, d, 'w'))
    for (const target of ['~/outside.txt', `${root}/outside.txt`, '/tmp/mffai-sbxe-outside', '~/.qoder/new-file']) {
      expect((await cli(`echo x > ${target}`)).code, target).not.toBe(0)
    }
    expect(existsSync(join(home, 'outside.txt'))).toBe(false)
    expect(existsSync('/tmp/mffai-sbxe-outside')).toBe(false)
  })

  it.each([
    ['cwd = a project', () => repo],
    ['cwd = ~/.qoder, where cwd itself is writable', () => qoder],
    ['cwd = home', () => home],
  ])('~/.qoder/bin, settings.json and external-commands stay write-denied: %s', async (_name, cwdOf) => {
    const cwd = cwdOf()
    const control = await cli('echo x > ./w.txt', { cwd })
    expect(control.code, control.err).toBe(0) // cwd 确实可写
    rmSync(join(cwd, 'w.txt'))
    for (const script of [
      'echo x > ~/.qoder/bin/x',
      'echo x > ~/.qoder/bin/qodercli/qodercli-1',
      'echo x > ~/.qoder/settings.json',
      'echo x > ~/.qoder/external-commands/x',
      'rm ~/.qoder/settings.json',
      'mv ~/.qoder/bin ~/.qoder/logs/bin',
      'mv ~/.qoder/settings.json ~/.qoder/logs/s',
      'mv ~/.qoder/external-commands ~/.qoder/logs/e',
    ]) {
      expect((await cli(script, { cwd })).code, script).not.toBe(0)
    }
    expect(readFileSync(join(qoder, 'settings.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(qoder, 'bin', 'qodercli', 'qodercli-1'), 'utf8')).toBe('program')
    expect(existsSync(join(qoder, 'bin', 'x'))).toBe(false)
    expect(existsSync(join(qoder, 'external-commands', 'x'))).toBe(false)
  })

  it('a planted node in a protected PATH dir fails, also by swapping the dir; without protection the same write works', async () => {
    const bun = join(home, '.bun', 'bin')
    mkdirSync(bun, { recursive: true })
    writeFileSync(join(bun, 'node'), 'real')
    try {
      for (const script of [
        'echo evil > ~/.bun/bin/node',
        'echo evil > ~/.bun/bin/python3',
        'rm ~/.bun/bin/node',
        'mv ~/.bun/bin ~/.bun/old',
        'mv ~/.bun ~/bun-old',
      ]) {
        expect((await cli(script, { cwd: home, protect: [bun] })).code, script).not.toBe(0)
      }
      expect(readFileSync(join(bun, 'node'), 'utf8')).toBe('real')
      expect(existsSync(join(bun, 'python3'))).toBe(false)
      expect((await cli('echo evil > ~/.bun/bin/python3', { cwd: home })).code).toBe(0)
    } finally {
      rmSync(join(home, '.bun'), { recursive: true, force: true })
    }
  })

  it('readOnly: cwd and .git are read-only, reading works, the session tmp and Qoder state stay writable', async () => {
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repo, 'r.txt'), 'READ')
    try {
      const ok = await cli('cat r.txt && echo x > "$TMPDIR/w" && echo x > ~/.qoder/logs/w', { readOnly: true })
      expect(ok.code, ok.err).toBe(0)
      expect(ok.out).toBe('READ\n')
      for (const script of ['echo x > ./w.txt', 'echo x > r.txt', 'rm r.txt', 'echo x > .git/HEAD', 'echo x > .git/objects-x']) {
        expect((await cli(script, { readOnly: true })).code, script).not.toBe(0)
      }
    } finally {
      rmSync(join(repo, '.git'), { recursive: true, force: true })
      rmSync(join(repo, 'r.txt'), { force: true })
      rmSync(join(qoder, 'logs', 'w'), { force: true })
    }
  })

  it('readOnly wins over allowWrite when cwd sits inside it', async () => {
    const r = await cli('echo x > ./w', { cwd: join(qoder, 'logs'), readOnly: true })
    expect(r.code).not.toBe(0)
    expect(existsSync(join(qoder, 'logs', 'w'))).toBe(false)
  })

  describe('user rules', () => {
    it('deny write(src/gen/**): writes and the move around it fail, the sibling works', async () => {
      rules = [rule('deny', 'write(src/gen/**)')]
      for (const script of ['echo x > src/gen/a', 'mv src/gen gen2', 'mv src src2', 'rm -r src']) {
        expect((await cli(script)).code, script).not.toBe(0)
      }
      expect(existsSync(join(repo, 'src', 'gen'))).toBe(true)
      const ok = await cli('echo x > src/ok && rm src/ok')
      expect(ok.code, ok.err).toBe(0)
    })

    it('deny write on a path that does not exist yet still holds', async () => {
      rules = [rule('deny', 'write(later/**)')]
      expect((await cli('mkdir -p later && echo x > later/a')).code).not.toBe(0)
      expect(existsSync(join(repo, 'later', 'a'))).toBe(false)
      rmSync(join(repo, 'later'), { recursive: true, force: true })
    })

    it('deny read(hidden/**): reading, moving out and linking out all fail', async () => {
      rules = [rule('deny', 'read(hidden/**)')]
      const control = await cli('cat .gitignore 2>/dev/null; echo visible > v.txt && cat v.txt && rm v.txt')
      expect(control.out).toContain('visible')
      for (const script of ['cat hidden/h.txt', 'mv hidden h2 && cat h2/h.txt', 'mv hidden/h.txt h.txt && cat h.txt', 'ln hidden/h.txt l.txt && cat l.txt', 'cp hidden/h.txt c.txt']) {
        const r = await cli(script)
        expect(r.code, script).not.toBe(0)
        expect(r.out, script).not.toContain('HIDDEN')
      }
      expect(readFileSync(join(repo, 'hidden', 'h.txt'), 'utf8')).toBe('HIDDEN')
    })

    it('a user rule on the exempted directory beats the exemption', async () => {
      rules = [rule('deny', 'read(~/.qoder/.auth/**)'), rule('deny', 'write(~/.qoder/.auth/**)')]
      const r = await cli('cat ~/.qoder/.auth/t')
      expect(r.code).not.toBe(0)
      expect(r.out).not.toContain('TOKEN')
      expect((await cli('echo x > ~/.qoder/.auth/w')).code).not.toBe(0)
    })

    it('a user rule beats the session tmp too', async () => {
      const tmp = join(data, 'sessions', SID, 'tmp')
      rules = [rule('deny', `write(${tmp}/**)`)]
      expect((await cli('echo x > "$TMPDIR/rule"')).code).not.toBe(0)
    })
  })

  describe('network', () => {
    it("the same session's shell can't read the exemption and gets 403 for Qoder's host; the run's proxy reaches the upstream", async () => {
      const s = await shell('cat ~/.qoder/.auth/t')
      s.plan.release()
      expect(s.code).not.toBe(0)
      expect(s.out).not.toContain('TOKEN')

      const before = upstream.connects.length
      const shellPlan = await svc.plan('true', session(repo), env())
      expect(await connectStatus(portOf(shellPlan.env), 'center.qoder.sh:443')).toMatch(/ 403 /)
      expect(upstream.connects.length).toBe(before)
      expect(appended.some(e => e.type === 'sandbox.netDenied' && e.sessionId === SID)).toBe(true)

      let runPort = 0
      const r = await cli('/usr/bin/curl -q -sS --max-time 5 -o /dev/null -w \'%{http_connect}\' https://center.qoder.sh/ 2>/dev/null; true', {
        keep: async p => { runPort = portOf(p.env) },
      })
      expect(runPort).toBeGreaterThan(0)
      expect(runPort).not.toBe(portOf(shellPlan.env))
      expect(r.out.trim()).toBe('200')
      expect(upstream.connects.slice(before).map(c => c.line)).toEqual(['CONNECT center.qoder.sh:443 HTTP/1.1'])
      shellPlan.release()
    })

    it("the run can reach only its own proxy, and the shell can't reach the run's", async () => {
      const shellPlan = await svc.plan('true', session(repo), env())
      const before = upstream.connects.length
      const direct = await cli(curlConnect(portOf(shellPlan.env)))
      expect(direct.out.trim()).toBe('000')
      expect(upstream.connects.length).toBe(before)
      shellPlan.release()

      let runPort = 0
      let shellOut = ''
      await cli('sleep 2', {
        keep: async p => {
          runPort = portOf(p.env)
          shellOut = (await shell(curlConnect(runPort))).out
        },
      })
      expect(runPort).toBeGreaterThan(0)
      expect(shellOut.trim()).toBe('000')
    })
  })
})
