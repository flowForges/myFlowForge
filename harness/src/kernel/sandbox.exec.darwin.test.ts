// 真跑 sandbox-exec(04 Review Focus 2):假 qodercli 经 planExec + runCli,临时 HOME。
// 只读 / 只写的断言都带一条能成功的对照:否则"什么都干不了"也会通过。
// 测试进程自己在沙箱里时不能嵌套 → 整个文件跳过(探测只跑一次)
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startFakeUpstream, type FakeServer } from '../../test/fakeUpstream'
import { NO_REPO, pinFromPaths } from '../lib/git/snapshot'
import { parseRule, type Rule } from '../lib/permissions/rules'
import { runCli } from '../lib/proc/runCli'
import type { ExecPlanOpts, SandboxService, ShellPlan } from '../lib/tools/types'
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

/** 同一会话的 shell 工具。异步起:代理跑在本进程,spawnSync 会堵住事件循环,连得上也会超时 */
async function shell(command: string, cwd = repo): Promise<{ code: number | null; out: string; env: NodeJS.ProcessEnv }> {
  const plan = await svc.plan(command, session(cwd), env())
  try {
    return await new Promise((resolve, reject) => {
      const c = spawn(plan.file, plan.args, { cwd, env: plan.env, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      c.stdout!.on('data', d => { out += d })
      c.on('error', reject)
      c.on('close', code => resolve({ code, out, env: plan.env }))
    })
  } finally {
    plan.release()
  }
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
    repoPin: () => (existsSync(join(repo, '.git')) ? pinFromPaths(repo, join(repo, '.git'), join(repo, '.git')) : NO_REPO),
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

  it('a wrapped run can not create or change <cwd>/.codex or .qoder, in any letter case (final review I-2)', async () => {
    const r = await cli('for d in .codex .qoder .CODEX .Qoder; do (mkdir "$d") 2>/dev/null && echo "MADE $d"; done; echo x > allowed.txt && echo WROTE; exit 0')
    expect(r.out).toBe('WROTE\n')
    expect(existsSync(join(repo, '.codex'))).toBe(false)
    expect(existsSync(join(repo, '.qoder'))).toBe(false)
    rmSync(join(repo, 'allowed.txt'))
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

  describe('moving a writable root (review C1)', () => {
    /** 两条路都验:委派的运行和 05 的 shell */
    const boxes: [string, (script: string, cwd?: string) => Promise<{ code: number | null; out: string }>][] = [
      ['planExec', (script, cwd) => cli(script, { cwd })],
      ['plan', (script, cwd) => shell(script, cwd)],
    ]
    beforeEach(() => {
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    })
    afterEach(() => {
      rmSync(join(repo, '.git'), { recursive: true, force: true })
    })

    describe.each(boxes)('%s', (_name, box) => {
      it('cwd and TMPDIR cannot be moved, and the repo stays where it was', async () => {
        for (const script of ['mv "$PWD" "$TMPDIR/r"', 'mv "$PWD" ../moved', 'mv "$TMPDIR" ./t', 'mv "$TMPDIR" "$TMPDIR.x"']) {
          expect((await box(script)).code, script).not.toBe(0)
        }
        expect(existsSync(join(repo, 'src', 'gen'))).toBe(true)
        expect(existsSync(join(repo, '.git', 'HEAD'))).toBe(true)
      })

      it('the .git/hooks plant via that trick fails', async () => {
        const r = await box('R="$TMPDIR/r"; O="$PWD"; mv "$O" "$R" && mv "$R/.git" "$R/g" && mkdir -p "$R/g/hooks" && echo evil > "$R/g/hooks/pre-commit"; mv "$R/g" "$R/.git"; mv "$R" "$O"; test -f "$O/.git/hooks/pre-commit"')
        expect(r.code).not.toBe(0)
        expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
      })

      it('ordinary renames inside the root still work', async () => {
        const r = await box('mkdir a && echo x > a/f && mv a/f a/g && mv a b && cat b/g && rm -r b && echo y > "$TMPDIR/f" && mv "$TMPDIR/f" "$TMPDIR/g" && mkdir "$TMPDIR/d" && mv "$TMPDIR/d" "$TMPDIR/e" && rm -r "$TMPDIR/g" "$TMPDIR/e"')
        expect(r.code).toBe(0)
        expect(r.out).toBe('x\n')
      })
    })

    it('planExec: moving cwd does not get around user rules', async () => {
      rules = [rule('deny', 'read(hidden/**)'), rule('deny', 'write(src/gen/**)')]
      const read = await cli('mv "$PWD" ~/.qoder/logs/r && cat ~/.qoder/logs/r/hidden/h.txt')
      expect(read.code).not.toBe(0)
      expect(read.out).not.toContain('HIDDEN')
      expect((await cli('R="$TMPDIR/r"; O="$PWD"; mv "$O" "$R" && echo evil > "$R/src/gen/a"; mv "$R" "$O"; test -f "$O/src/gen/a"')).code).not.toBe(0)
      expect(existsSync(join(repo, 'src', 'gen', 'a'))).toBe(false)
    })

    it('planExec: cwd in a subdirectory cannot move into the git dir beside it', async () => {
      const sub = join(repo, 'src')
      expect((await cli('mv "$PWD" ../.git/x', { cwd: sub })).code).not.toBe(0)
      expect(existsSync(sub)).toBe(true)
    })

    it('planExec: ~/.qoder/projects holding cwd cannot move', async () => {
      const cwd = join(qoder, 'projects', 'p')
      mkdirSync(cwd)
      try {
        expect((await cli('mv ~/.qoder/projects ~/.qoder/logs/x', { cwd })).code).not.toBe(0)
        expect((await cli('mv "$PWD" ~/.qoder/logs/x', { cwd })).code).not.toBe(0)
        expect(existsSync(cwd)).toBe(true)
      } finally {
        rmSync(cwd, { recursive: true })
      }
    })
  })

  describe('the .qoder entries are not the run\'s to swap (review I1)', () => {
    it.each([
      ['cwd = a project', () => repo],
      ['cwd = ~/.qoder', () => qoder],
    ])('existing entries cannot be replaced: %s', async (_name, cwdOf) => {
      const cwd = cwdOf()
      for (const script of [
        `mv ~/.qoder/logs ~/.qoder/cache/l && ln -s ${root} ~/.qoder/logs`,
        `rm -rf ~/.qoder/logs && ln -s ${root} ~/.qoder/logs`,
        'mv ~/.qoder/cache ~/.qoder/logs/c',
      ]) {
        expect((await cli(script, { cwd })).code, script).not.toBe(0)
      }
      expect(lstatSync(join(qoder, 'logs')).isDirectory()).toBe(true)
      expect(existsSync(join(qoder, 'cache'))).toBe(true)
    })

    it('a listed entry that is missing cannot be created, not even at cwd = ~/.qoder', async () => {
      rmSync(join(qoder, '.cache'), { recursive: true })
      try {
        for (const script of ['mkdir ~/.qoder/.cache', `ln -s ${root} ~/.qoder/.cache`]) {
          expect((await cli(script, { cwd: qoder })).code, script).not.toBe(0)
        }
        expect(existsSync(join(qoder, '.cache'))).toBe(false)
        const control = await cli('echo x > ./w && rm ./w', { cwd: qoder })
        expect(control.code, control.err).toBe(0)
      } finally {
        mkdirSync(join(qoder, '.cache'), { recursive: true })
      }
    })
  })

  describe('real denials through planExec (review M2)', () => {
    beforeEach(() => {
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(repo, '.git', 'config'), '[core]\n')
    })
    afterEach(() => {
      rmSync(join(repo, '.git'), { recursive: true, force: true })
    })

    it('data dir and another session\'s tmp cannot be read; own tmp can', async () => {
      const other = join(data, 'sessions', 's2', 'tmp')
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, 'x'), 'OTHER')
      writeFileSync(join(data, 'config.json'), 'CONFIG')
      for (const f of [join(other, 'x'), join(data, 'config.json')]) {
        const r = await cli(`cat ${f}`)
        expect(r.code, f).not.toBe(0)
        expect(r.out, f).toBe('')
      }
      const own = await cli('echo mine > "$TMPDIR/o" && cat "$TMPDIR/o" && rm "$TMPDIR/o"')
      expect(own.out).toBe('mine\n')
    })

    it('own spill is readable, not writable', async () => {
      const spill = session(repo).spillDir
      mkdirSync(spill, { recursive: true })
      writeFileSync(join(spill, 's'), 'SPILL\n')
      const ok = await cli(`cat ${spill}/s`)
      expect(ok.out).toBe('SPILL\n')
      expect((await cli(`echo x > ${spill}/w`)).code).not.toBe(0)
      expect((await cli(`echo x >> ${spill}/s`)).code).not.toBe(0)
      expect(readFileSync(join(spill, 's'), 'utf8')).toBe('SPILL\n')
    })

    it('.git/hooks and .git/config cannot be written in write mode; other .git files can', async () => {
      for (const script of ['echo x > .git/hooks/pre-commit', 'echo x >> .git/config', 'rm .git/config']) {
        expect((await cli(script)).code, script).not.toBe(0)
      }
      expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe('[core]\n')
      expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false)
      const ok = await cli('echo x > .git/index-test && rm .git/index-test')
      expect(ok.code, ok.err).toBe(0)
    })

    it('~/.zshrc stays write-denied at cwd = home, existing or not', async () => {
      writeFileSync(join(home, '.zshrc'), 'rc\n')
      try {
        for (const script of ['echo evil >> ~/.zshrc', 'rm ~/.zshrc', 'echo evil > ~/.bashrc']) {
          expect((await cli(script, { cwd: home })).code, script).not.toBe(0)
        }
        expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('rc\n')
        expect(existsSync(join(home, '.bashrc'))).toBe(false)
      } finally {
        rmSync(join(home, '.zshrc'), { force: true })
      }
    })
  })

  it('a persistence file inside the exemption stays write-denied (review M3)', async () => {
    // 文件要已存在:不存在时改名黑名单就挡住了新建,验不到写规则
    const gc = join(qoder, '.auth', 'gc')
    writeFileSync(gc, 'orig\n')
    const outer = svc
    svc = makeService({ HOME: home, GIT_CONFIG_GLOBAL: gc })
    try {
      expect((await cli('echo evil > ~/.qoder/.auth/gc')).code).not.toBe(0)
      expect(readFileSync(gc, 'utf8')).toBe('orig\n')
      const ok = await cli('echo x > ~/.qoder/.auth/w && rm ~/.qoder/.auth/w')
      expect(ok.code, ok.err).toBe(0)
    } finally {
      await svc.close()
      svc = outer
      rmSync(gc, { force: true })
    }
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

      // 对照:同一条 curl 在沙箱外(同样异步)连得上,所以下面的 000 只能是沙箱拦的
      let runPort = 0
      let control = ''
      let shellOut = ''
      const mid = { connects: 0 }
      await cli('sleep 3', {
        keep: async p => {
          runPort = portOf(p.env)
          control = await new Promise<string>(resolve => {
            const c = spawn('/bin/sh', ['-c', curlConnect(runPort)], { stdio: ['ignore', 'pipe', 'ignore'] })
            let o = ''
            c.stdout!.on('data', d => { o += d })
            c.on('close', () => resolve(o))
          })
          mid.connects = upstream.connects.length
          shellOut = (await shell(curlConnect(runPort))).out
          expect(upstream.connects.length).toBe(mid.connects)
        },
      })
      expect(runPort).toBeGreaterThan(0)
      expect(control.trim()).toBe('200')
      expect(shellOut.trim()).toBe('000')
    })
  })
})

describe.skipIf(!usable)('planExec with hide, real sandbox-exec (09 Task 1, M1, M4, M13)', () => {
  let box = ''
  let h = ''
  let dataDir = ''
  let store = ''
  let cwd = ''
  let code = ''
  let runtime = ''
  let nodeBin = ''
  let serverData = ''
  let tmpDir = ''
  let sessionTmp = ''
  let spill = ''
  let up: FakeServer
  let sbx: SandboxService
  let loopback: SandboxService
  let n = 0

  const spawnPlan = (plan: ShellPlan, dir: string) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const c = spawn(plan.file, plan.args, { cwd: dir, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      c.stdout!.on('data', d => { out += d })
      c.stderr!.on('data', d => { err += d })
      c.on('error', reject)
      c.on('close', code => resolve({ code, out, err }))
    })

  /** 服务的选项,和 09 §10.3 同形:argv 版计划,读写由 hide 定 */
  async function serve(file: string, args: string[], o: Partial<ExecPlanOpts> = {}, s: SandboxService = sbx, dir = cwd) {
    const plan = await s.planExec(file, args, { sessionId: 's1', cwd: dir, spillDir: spill }, { PATH: '/usr/bin:/bin', HOME: serverData, LC_ALL: 'C' }, {
      allowRead: [serverData],
      allowWrite: [serverData],
      allowHosts: [],
      exactHosts: true,
      proxyScope: `mcp_${++n}`,
      readOnly: true,
      denyRead: [],
      denyWrite: [],
      hide: { tops: [h, store, join(box, 'systmp')], keep: [cwd, code, runtime] },
      tmpDir,
      ...o,
    })
    expect(plan.sandboxed).toBe(true)
    try {
      return { ...(await spawnPlan(plan, dir)), env: plan.env }
    } finally {
      plan.release()
    }
  }
  const cat = (p: string, o?: Partial<ExecPlanOpts>) => serve('/bin/cat', [p], o)
  const sh2 = (script: string, o?: Partial<ExecPlanOpts>) => serve('/bin/sh', ['-c', script], o)

  beforeAll(async () => {
    box = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-hide-')))
    h = join(box, 'home')
    dataDir = join(h, '.myFlowForge', 'mff-ai')
    store = `${dataDir}-plugins`
    cwd = join(h, 'proj')
    code = join(store, 'p', 'abc123')
    runtime = join(h, '.nvm', 'versions', 'node', 'v1')
    serverData = join(dataDir, 'plugin-data', 'p', 'srv')
    tmpDir = join(dataDir, 'sessions', 's1', 'mcp', 'h1', 'tmp')
    sessionTmp = join(dataDir, 'sessions', 's1', 'tmp')
    spill = join(dataDir, 'sessions', 's1', 'mcp', 'h1', 'spill')
    for (const d of [cwd, code, join(runtime, 'bin'), serverData, sessionTmp, spill, join(h, 'other'), join(h, '.ssh'), join(box, 'systmp'), join(h, '.config', 'gh'), join(h, '.config', 'tool')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(h, 'notes.txt'), 'NOTES')
    writeFileSync(join(h, 'other', 'x'), 'SIBLING')
    writeFileSync(join(h, '.ssh', 'id'), 'SSHKEY')
    writeFileSync(join(cwd, 'a.txt'), 'CWD-FILE')
    writeFileSync(join(code, 'server.js'), "process.stdout.write('from-code ' + require('node:fs').realpathSync(__filename))\n")
    writeFileSync(join(sessionTmp, 'shell-tmp'), 'SHELL-TMP')
    writeFileSync(join(serverData, 'mine'), 'MINE')
    writeFileSync(join(box, 'systmp', 'other-program'), 'SYS-TMP')
    writeFileSync(join(h, '.config', 'gh', 'hosts.yml'), 'GH-TOKEN')
    writeFileSync(join(h, '.config', 'tool', 'ok'), 'TOOL-OK')
    // 真的 node 拷进隐藏的家目录里,和 nvm 的布局一样
    const real = realpathSync(process.execPath)
    nodeBin = join(runtime, 'bin', 'node')
    copyFileSync(real, nodeBin, fsConstants.COPYFILE_FICLONE)
    const libDir = join(dirname(dirname(real)), 'lib')
    if (existsSync(libDir)) {
      mkdirSync(join(runtime, 'lib'))
      for (const f of readdirSync(libDir).filter(x => x.startsWith('libnode'))) copyFileSync(join(libDir, f), join(runtime, 'lib', f), fsConstants.COPYFILE_FICLONE)
    }
    up = await startFakeUpstream()
    const make = (allowLoopback: boolean) => createSandboxService({
      platform: 'darwin', dataDir, home: h, env: { HOME: h }, detected: { level: 'full', missing: [] },
      permissions: () => ({ rules: [], network: { allow: ['github.com'] }, sandbox: { enabled: true, allowLoopback }, allowUnsandboxedAuto: false }),
      rules: () => [],
      append: () => {},
      upstream: { url: new URL(`http://127.0.0.1:${up.port}`), noProxy: () => false },
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    })
    sbx = make(false)
    loopback = make(true)
  })
  afterAll(async () => {
    await sbx?.close()
    await loopback?.close()
    await up?.close()
    if (box) rmSync(box, { recursive: true, force: true })
  })

  it('a hide top is unreadable; a kept dir reads; a sibling of it does not', async () => {
    expect((await cat(join(cwd, 'a.txt'))).out).toBe('CWD-FILE')
    expect(await cat(join(h, 'notes.txt'))).toMatchObject({ out: '', code: 1 })
    expect(await cat(join(h, 'other', 'x'))).toMatchObject({ out: '', code: 1 })
    // 祖先只有元数据:列不出目录
    expect((await serve('/bin/ls', [h])).code).not.toBe(0)
    expect((await serve('/bin/ls', [cwd])).out).toContain('a.txt')
  })

  it('the rest of the top stays closed: a credential root, the system temp dir', async () => {
    expect(await cat(join(h, '.ssh', 'id'))).toMatchObject({ out: '', code: 1 })
    expect(await cat(join(box, 'systmp', 'other-program'))).toMatchObject({ out: '', code: 1 })
  })

  it('I-4: each hide plan carries its own proxy credential in all six variables; a scoped run without hide and a shell plan carry none', async () => {
    const a = await serve('/usr/bin/true', [])
    const b = await serve('/usr/bin/true', [])
    const url = (env: NodeJS.ProcessEnv) => new URL(env.HTTP_PROXY!)
    expect(url(a.env).username).toBe('mff')
    expect(url(a.env).password).toMatch(/^[0-9a-f]{48}$/)
    expect(url(b.env).password).not.toBe(url(a.env).password)
    for (const k of ['HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) expect(a.env[k]).toBe(a.env.HTTP_PROXY)
    const run = await sbx.planExec('/usr/bin/true', [], { sessionId: 's1', cwd, spillDir: spill }, { PATH: '/usr/bin:/bin' }, { allowRead: [], allowWrite: [], allowHosts: [], proxyScope: `run_${++n}`, readOnly: true, denyRead: [], denyWrite: [] })
    const shell = await sbx.plan('true', { sessionId: 's1', cwd, spillDir: spill }, { PATH: '/usr/bin:/bin' })
    try {
      for (const p of [run, shell]) expect(p.env.HTTP_PROXY).toBe(`http://127.0.0.1:${url(p.env).port}`)
    } finally {
      run.release()
      shell.release()
    }
  })

  it('a credential dir under a kept dir stays unreadable; its neighbour reads', async () => {
    const o = { hide: { tops: [h], keep: [cwd, join(h, '.config')] } }
    expect((await cat(join(h, '.config', 'tool', 'ok'), o)).out).toBe('TOOL-OK')
    expect(await cat(join(h, '.config', 'gh', 'hosts.yml'), o)).toMatchObject({ out: '', code: 1 })
  })

  it('a kept dir holding the data dir: a file in the data dir stays unreadable', async () => {
    writeFileSync(join(dataDir, 'token'), 'TOKEN')
    const o = { hide: { tops: [h], keep: [cwd, join(h, '.myFlowForge')] } }
    expect(await cat(join(dataDir, 'token'), o)).toMatchObject({ out: '', code: 1 })
  })

  /** 这台机器的 node 拷出来跑不了(依赖找不到)时跳过:和隐藏无关 */
  const copiedNodeRuns = () => spawnSync(nodeBin, ['-e', '0'], { stdio: 'ignore' }).status === 0

  describe('the data dir under the kept cwd', () => {
    /** 数据目录在 home/.mff/data。linked:.mff 是链接,真身在 cwd 里;plain:.mff 就是 cwd */
    async function layout(linked: boolean) {
      const base = mkdtempSync(join(box, 'layout-'))
      const lh = join(base, 'home')
      const ext = linked ? join(base, 'ext') : join(lh, '.mff')
      const realData = join(ext, linked ? 'mff' : '', 'data')
      mkdirSync(realData, { recursive: true })
      mkdirSync(lh, { recursive: true })
      if (linked) symlinkSync(join(ext, 'mff'), join(lh, '.mff'))
      writeFileSync(join(realData, 'token'), 'DATA-TOKEN')
      writeFileSync(join(ext, 'a.txt'), 'CWD-FILE')
      const data2 = join(lh, '.mff', 'data')
      const s2 = createSandboxService({
        platform: 'darwin', dataDir: data2, home: lh, env: { HOME: lh }, detected: { level: 'full', missing: [] },
        permissions: () => ({ rules: [], network: { allow: [] }, sandbox: { enabled: true, allowLoopback: false }, allowUnsandboxedAuto: false }),
        rules: () => [], append: () => {},
      })
      const go = async (path: string, tops = [lh]) => {
        const plan = await s2.planExec('/bin/cat', [path], { sessionId: 's1', cwd: ext, spillDir: join(data2, 'sessions', 's1', 'spill') }, { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, {
          allowRead: [], allowWrite: [], allowHosts: [], exactHosts: true, proxyScope: `mcp_${++n}`, readOnly: true, denyRead: [], denyWrite: [], hide: { tops, keep: [ext] },
        })
        try {
          return await spawnPlan(plan, ext)
        } finally {
          plan.release()
        }
      }
      return { go, s2, ext, lh, realData, literal: data2 }
    }

    it('the data dir reached through a link: closed in its real spelling and the literal one; the cwd still reads', async () => {
      const l = await layout(true)
      try {
        expect((await l.go(join(l.ext, 'a.txt'))).out).toBe('CWD-FILE')
        expect(await l.go(join(l.realData, 'token'))).toMatchObject({ out: '', code: 1 })
        expect(await l.go(join(l.literal, 'token'))).toMatchObject({ out: '', code: 1 })
      } finally {
        await l.s2.close()
      }
    })

    it('control, no link: the same rows', async () => {
      const l = await layout(false)
      try {
        expect((await l.go(join(l.ext, 'a.txt'))).out).toBe('CWD-FILE')
        expect(await l.go(join(l.realData, 'token'))).toMatchObject({ out: '', code: 1 })
      } finally {
        await l.s2.close()
      }
    })

    it('with the store as a top, the kept cwd holds it through the link: refused, nothing ran', async () => {
      const l = await layout(true)
      try {
        await expect(l.go(join(l.ext, 'a.txt'), [l.lh, `${l.literal}-plugins`])).rejects.toThrow(/holds a hidden root/)
      } finally {
        await l.s2.close()
      }
    })
  })

  it("cwd:'none' with the cwd inside the runtime root: refused, the file stays unread", async () => {
    const inside = join(runtime, 'lib', 'proj')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'secret'), 'INSIDE')
    await expect(serve('/bin/cat', [join(inside, 'secret')], { hide: { tops: [h, inside], keep: [code, runtime] } }, sbx, inside)).rejects.toThrow(/holds a hidden root/)
  })

  it('node runs from a kept runtime root under the hidden home, and loads a script from kept code', async ctx => {
    if (!copiedNodeRuns()) ctx.skip()
    const r = await serve(nodeBin, ['-e', "process.stdout.write('ran ' + process.version)"])
    expect(r.out).toMatch(/^ran v/)
    expect(r.code).toBe(0)
    const script = await serve(nodeBin, [join(code, 'server.js')])
    expect(script.out).toBe(`from-code ${join(code, 'server.js')}`)
    // 没放回来的话同一个程序根本起不来:对照
    const closed = await serve(nodeBin, ['-e', '0'], { hide: { tops: [h], keep: [cwd] } })
    expect(closed.code).not.toBe(0)
  })

  it('node finds its way to the data dir through the hidden ancestors', async ctx => {
    if (!copiedNodeRuns()) ctx.skip()
    const script = `const fs = require('node:fs'); process.stdout.write(fs.realpathSync(${JSON.stringify(serverData)}) + ' ' + fs.realpathSync(process.env.TMPDIR))`
    const r = await serve(nodeBin, ['-e', script])
    expect(r.out).toBe(`${serverData} ${tmpDir}`)
  })

  it('tmpDir is writable and is TMPDIR; the session tmp is neither readable nor writable', async () => {
    const r = await sh2(`echo made > "$TMPDIR/f" && cat "$TMPDIR/f"`)
    expect(r.out.trim()).toBe('made')
    expect(r.env.TMPDIR).toBe(tmpDir)
    expect(await cat(join(sessionTmp, 'shell-tmp'))).toMatchObject({ out: '', code: 1 })
    expect((await sh2(`echo x > ${JSON.stringify(join(sessionTmp, 'planted'))}`)).code).not.toBe(0)
    expect(existsSync(join(sessionTmp, 'planted'))).toBe(false)
  })

  it('own data reads and writes; the kept cwd does not take writes; own code does not either', async () => {
    expect((await cat(join(serverData, 'mine'))).out).toBe('MINE')
    expect((await sh2(`echo y > ${JSON.stringify(join(serverData, 'new'))}`)).code).toBe(0)
    expect((await sh2(`echo y > ${JSON.stringify(join(cwd, 'planted'))}`)).code).not.toBe(0)
    expect((await sh2(`echo y > ${JSON.stringify(join(code, 'planted'))}`)).code).not.toBe(0)
    expect(existsSync(join(cwd, 'planted'))).toBe(false)
    expect(existsSync(join(code, 'planted'))).toBe(false)
    // cwd:'write':对照
    expect((await sh2(`echo y > ${JSON.stringify(join(cwd, 'granted'))}`, { readOnly: false })).code).toBe(0)
    expect(existsSync(join(cwd, 'granted'))).toBe(true)
    rmSync(join(cwd, 'granted'))
  })

  it("cwd hidden (cwd:'none'): unreadable", async () => {
    const r = await serve('/bin/cat', [join(cwd, 'a.txt')], { hide: { tops: [h, cwd], keep: [code, runtime] } }, sbx, serverData)
    expect(r).toMatchObject({ out: '', code: 1 })
  })

  it('exactHosts: the proxy refuses a default-list host, passes a granted one; loopback stays shut even with allowLoopback', async () => {
    const curlVia = (target: string) => `/usr/bin/curl -q -sS --max-time 5 -o /dev/null -w '%{http_connect}' "https://${target}/" 2>/dev/null; true`
    const blocked = await sh2(curlVia('github.com'))
    expect(blocked.out).toBe('403')
    const granted = await sh2(curlVia('api.example.com'), { allowHosts: ['api.example.com'] })
    expect(granted.out).not.toBe('403')
    expect(await sh2(curlVia('github.com'), { allowHosts: ['api.example.com'] })).toMatchObject({ out: '403' })
    const direct = `/usr/bin/curl -q -sS --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${up.port}/ 2>/dev/null; true`
    // 对照:同样的配置,不带 exactHosts 就连得上
    const open = await serve('/bin/sh', ['-c', direct], { exactHosts: undefined }, loopback)
    expect(open.out).not.toBe('000')
    expect((await serve('/bin/sh', ['-c', direct], {}, loopback)).out).toBe('000')
  })

  it("the session's own shell can't change the store, even at cwd = home; it can read it (M13)", async () => {
    writeFileSync(join(code, 'skill.md'), 'SKILL')
    const shell2 = async (cmd: string) => {
      const plan = await sbx.plan(cmd, { sessionId: 's2', cwd: h, spillDir: join(dataDir, 'sessions', 's2', 'spill') }, { PATH: '/usr/bin:/bin', HOME: h })
      try {
        return await spawnPlan(plan, h)
      } finally {
        plan.release()
      }
    }
    expect((await shell2(`cat ${JSON.stringify(join(code, 'skill.md'))}`)).out).toBe('SKILL')
    expect((await shell2(`echo x >> ${JSON.stringify(join(code, 'skill.md'))}`)).code).not.toBe(0)
    expect((await shell2(`mv ${JSON.stringify(store)} ${JSON.stringify(`${store}-moved`)}`)).code).not.toBe(0)
    expect((await shell2(`mv ${JSON.stringify(join(h, '.myFlowForge'))} ${JSON.stringify(join(h, 'moved'))}`)).code).not.toBe(0)
    expect((await shell2(`rm -rf ${JSON.stringify(join(store, 'p'))}`)).code).not.toBe(0)
    expect(readFileSync(join(code, 'skill.md'), 'utf8')).toBe('SKILL')
    // 对照:同一个 shell 写得了家目录
    expect((await shell2(`echo x > ${JSON.stringify(join(h, 'ok'))}`)).code).toBe(0)
  })
})
