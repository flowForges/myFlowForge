import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, PermissionGate, type DecideEnv } from '../../kernel/permissionGate'
import type { SessionInfo } from '../../kernel/sessions'
import { literalRoots, parseRule, type Effect, type MatchCtx, type Rule } from '../../lib/permissions/rules'
import type { ExecPolicy, PermissionRequest } from '../../lib/tools/types'
import type { ExecutorIsolation } from '../../protocol/tools'
import { codexAdapter } from './adapters/codex'
import { checkViolations, mustAsk, protectDirs, translate, treePolicy } from './policy'

let root: string
let cwd: string
let home: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-policy-')))
  cwd = join(root, 'repo')
  home = join(root, 'home')
  mkdirSync(cwd)
  mkdirSync(home)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function rule(effect: Effect, text: string): Rule {
  const r = parseRule({ effect, rule: text })
  if ('reason' in r) throw new Error(`bad rule ${text}`)
  return r
}

/** Task 7 之前的替身:execPolicy 将来也这样从规则算出这些字段 */
function policyOf(rules: Rule[], over: Partial<ExecPolicy> = {}): ExecPolicy {
  const ctx: MatchCtx = { cwd, home, platform: process.platform, realpath: realpathSync.native }
  const read = literalRoots(rules, 'read', ctx)
  const write = literalRoots(rules, 'write', ctx)
  const shell = rules.filter(r => r.subject === 'shell' && r.effect !== 'allow').length
  return {
    denyRead: ['/h/.ssh', '/h/data'],
    persistence: ['/h/.zshrc'],
    dataDir: '/h/data',
    level: 'full',
    ruleDenyRead: read.roots,
    ruleDenyWrite: write.roots,
    untranslatedRules: read.untranslated + write.untranslated + shell,
    totalRules: rules.filter(r => r.effect !== 'allow').length,
    ...over,
  }
}

function envOf(rules: Rule[]): DecideEnv {
  return {
    roots: [],
    persistence: [],
    dataDir: join(root, 'data'),
    platform: process.platform,
    rules,
    sandbox: { level: 'full', missing: [], autoDegraded: false },
    allowUnsandboxedAuto: false,
    home,
    realpath: realpathSync.native,
  }
}

const session = (): SessionInfo => ({ sessionId: 's', cwd, approvalMode: 'auto' }) as SessionInfo

/** 委派工具的 exec 请求(Task 10 的 permission() 就是这样发的) */
function exec(rules: Rule[], isolation: ExecutorIsolation, over: Partial<DecideEnv> = {}): string {
  const req: PermissionRequest = { actor: 'tools', action: 'exec', resource: 'codex', sessionId: 's', unsandboxed: isolation === 'none', mustAsk: mustAsk(policyOf(rules), isolation) }
  return decide(req, session(), { ...envOf(rules), ...over })
}

function gateFor(rules: Rule[]) {
  return new PermissionGate({
    sessions: { get: () => session(), spillDir: () => join(root, 'spill') },
    home,
    dataDir: join(root, 'data'),
    platform: process.platform,
    env: {},
    permissions: () => ({ rules, config: { allowUnsandboxedAuto: false } }),
    sandbox: () => ({ level: 'full', missing: [], autoDegraded: false }),
  })
}

const codexFs = (p: ExecPolicy, readOnly = false) => {
  const t = translate(p)
  const { args } = codexAdapter.buildArgs({ prompt: 'x', cwd, readOnly, isolation: 'own', denyRead: t.denyRead, readOnlyPaths: t.readOnlyPaths, network: false })
  return args.find(a => a.startsWith('permissions.mffai.filesystem='))!
}

describe('translate', () => {
  it('Codex lists: creds and rule reads go to none; persistence and rule writes to read', () => {
    const p = policyOf([rule('deny', 'read(hidden/**)'), rule('deny', 'write(src/gen/**)')])
    expect(translate(p)).toEqual({
      denyRead: ['/h/.ssh', '/h/data', join(cwd, 'hidden')],
      readOnlyPaths: ['/h/.zshrc', join(cwd, 'src/gen')],
      denyWrite: [join(cwd, 'src/gen')],
      untranslated: 0,
    })
  })

  it('denyWrite for a wrapped run is rule paths only: 05 already covers persistence', () => {
    expect(translate(policyOf([])).denyWrite).toEqual([])
  })

  it('write-protects the directories of the chosen binary, on both kinds of isolation', () => {
    const t = translate(policyOf([]), ['/h/.local/bin', '/opt/codex/bin'])
    expect(t.readOnlyPaths).toEqual(['/h/.zshrc', '/h/.local/bin', '/opt/codex/bin'])
    expect(t.denyWrite).toEqual(['/h/.local/bin', '/opt/codex/bin'])
    expect(t.denyRead).toEqual(['/h/.ssh', '/h/data'])
  })

  it('removes duplicates', () => {
    const t = translate(policyOf([], { denyRead: ['/a', '/a'], ruleDenyRead: ['/a'], persistence: ['/b'], ruleDenyWrite: ['/b', '/b'] }))
    expect(t).toMatchObject({ denyRead: ['/a'], readOnlyPaths: ['/b'], denyWrite: ['/b'] })
  })
})

describe('mustAsk', () => {
  it.each<[ExecutorIsolation, number, number, boolean]>([
    ['own', 0, 0, false],
    ['own', 3, 0, false],
    ['own', 3, 1, true],
    ['wrapped', 3, 0, false],
    ['wrapped', 3, 1, true],
    // 没有隔离时一条规则也落实不了
    ['none', 0, 0, false],
    ['none', 1, 0, true],
    ['none', 3, 1, true],
  ])('%s, total %i, untranslated %i → %s', (isolation, totalRules, untranslatedRules, want) => {
    expect(mustAsk(policyOf([], { totalRules, untranslatedRules }), isolation)).toBe(want)
  })
})

describe('user rules (Review Focus 2)', () => {
  it('deny write(src/gen/**): Codex read entry, wrapped denyWrite, no approval in auto', () => {
    const rules = [rule('deny', 'write(src/gen/**)')]
    const p = policyOf(rules)
    expect(codexFs(p)).toContain(`"${join(cwd, 'src/gen')}"="read"`)
    expect(translate(p).denyWrite).toEqual([join(cwd, 'src/gen')])
    expect(mustAsk(p, 'own')).toBe(false)
    expect(exec(rules, 'own')).toBe('allow')
    expect(exec(rules, 'wrapped')).toBe('allow')
  })

  it('ask write(src/gen/**) is enforced the same way: nobody can be asked mid-run', () => {
    const rules = [rule('ask', 'write(src/gen/**)')]
    expect(codexFs(policyOf(rules))).toContain(`"${join(cwd, 'src/gen')}"="read"`)
    expect(exec(rules, 'own')).toBe('allow')
  })

  it('a symlinked rule path is denied in both spellings', () => {
    mkdirSync(join(root, 'target'))
    symlinkSync(join(root, 'target'), join(cwd, 'link'))
    const fs = codexFs(policyOf([rule('deny', 'write(link/**)')]))
    expect(fs).toContain(`"${join(cwd, 'link')}"="read"`)
    expect(fs).toContain(`"${join(root, 'target')}"="read"`)
  })

  it.each(['write(**/*.env)', 'read(**/*.env)', 'shell(git push*)'])('deny %s is not translated: auto asks', text => {
    const rules = [rule('deny', text)]
    const p = policyOf(rules)
    expect(translate(p).untranslated).toBe(1)
    expect(mustAsk(p, 'own')).toBe(true)
    expect(mustAsk(p, 'wrapped')).toBe(true)
    expect(exec(rules, 'own')).toBe('ask')
    expect(exec(rules, 'wrapped')).toBe('ask')
    expect(codexFs(p)).not.toContain('*.env')
  })

  it('allow rules do not count, and an allow shell(codex) cannot skip the question', () => {
    const allow = [rule('allow', 'write(**/*.env)'), rule('allow', 'read(x)')]
    expect(mustAsk(policyOf(allow), 'own')).toBe(false)
    expect(mustAsk(policyOf(allow), 'none')).toBe(false)
    expect(exec([rule('deny', 'write(**/*.env)'), rule('allow', 'shell(codex)')], 'own')).toBe('ask')
  })

  it('deny read(**) stops a read-only delegation at read(<cwd>)', () => {
    expect(decide({ actor: 'tools', action: 'read', resource: cwd, sessionId: 's' }, session(), envOf([rule('deny', 'read(**)')]))).toBe('deny')
  })

  it('deny write(**): write mode denied at write(<cwd>); read-only runs with no prompt', () => {
    const rules = [rule('deny', 'write(**)')]
    const env = envOf(rules)
    expect(decide({ actor: 'tools', action: 'write', resource: cwd, sessionId: 's' }, session(), env)).toBe('deny')
    expect(decide({ actor: 'tools', action: 'read', resource: cwd, sessionId: 's' }, session(), env)).toBe('allow')
    expect(exec(rules, 'own')).toBe('allow')
    expect(codexFs(policyOf(rules), true)).toContain(`"${cwd}"="read"`)
  })

  it('a bracket in a rule path: wrapped keeps enforcing it; Codex degrades to none and asks', () => {
    const rules = [rule('deny', 'write(src/[a]/**)')]
    const p = policyOf(rules)
    const t = translate(p)
    expect(t.denyWrite).toEqual([join(cwd, 'src/[a]')])
    expect(mustAsk(p, 'wrapped')).toBe(false)
    expect(codexAdapter.profileGaps!({ cwd, denyRead: t.denyRead, readOnlyPaths: t.readOnlyPaths })).toEqual(['codex_path_glob'])
    expect(mustAsk(p, 'none')).toBe(true)
  })
})

describe('the self-test row at the gate', () => {
  it.each([false, true])('a failed self-test in an auto session at full asks, allowUnsandboxedAuto=%s', allowUnsandboxedAuto => {
    expect(exec([], 'none', { allowUnsandboxedAuto })).toBe('ask')
    expect(exec([rule('allow', 'shell(codex)')], 'none', { allowUnsandboxedAuto })).toBe('ask')
  })

  it('a passing self-test runs in auto', () => {
    expect(exec([], 'own')).toBe('allow')
  })
})

describe('checkViolations', () => {
  it('lists the .env the CLI wrote, not the other files', () => {
    writeFileSync(join(cwd, 'a.env'), 'x')
    writeFileSync(join(cwd, 'ok.txt'), 'x')
    const gate = gateFor([rule('deny', 'write(**/*.env)')])
    expect(checkViolations(gate, 's', ['a.env', 'ok.txt', 'sub/b.env'], cwd)).toEqual(['a.env', 'sub/b.env'])
  })

  it('an ask rule counts: nobody approved that write', () => {
    expect(checkViolations(gateFor([rule('ask', 'write(*.lock)')]), 's', ['a.lock', 'b.txt'], cwd)).toEqual(['a.lock'])
  })

  it('catches a deleted file, by the path it had', () => {
    expect(checkViolations(gateFor([rule('deny', 'write(gone/**)')]), 's', ['gone/x.ts'], cwd)).toEqual(['gone/x.ts'])
  })

  it('anything outside the session cwd or under .git is a violation', () => {
    const gate = gateFor([])
    expect(checkViolations(gate, 's', ['../outside', '.git/config', join(root, 'abs'), 'fine.txt'], cwd)).toEqual(['../outside', '.git/config', join(root, 'abs')])
  })

  it('a link that leads outside is judged by where it leads', () => {
    mkdirSync(join(root, 'target'))
    symlinkSync(join(root, 'target'), join(cwd, 'link'))
    expect(checkViolations(gateFor([]), 's', ['link/x'], cwd)).toEqual(['link/x'])
  })

  it('a path the resolver refuses is a violation, not a skip', () => {
    expect(checkViolations(gateFor([]), 's', ['a\0b'], cwd)).toEqual(['a\0b'])
  })

  it('a refused path does not shift the decisions of the files after it', () => {
    expect(checkViolations(gateFor([rule('deny', 'write(*.env)')]), 's', ['a\0b', 'ok.txt', 'x.env'], cwd)).toEqual(['a\0b', 'x.env'])
  })

  it('asks once per batch and sends write requests for this session', () => {
    const seen: PermissionRequest[][] = []
    const gate = { checkMany: (r: PermissionRequest[]) => (seen.push(r), r.map(() => 'allow' as const)) }
    expect(checkViolations(gate, 's1', ['a', 'b'], cwd)).toEqual([])
    expect(seen).toEqual([[
      { actor: 'tools', action: 'write', resource: join(cwd, 'a'), sessionId: 's1' },
      { actor: 'tools', action: 'write', resource: join(cwd, 'b'), sessionId: 's1' },
    ]])
    expect(checkViolations(gate, 's1', [], cwd)).toEqual([])
    expect(seen).toHaveLength(1)
  })
})

describe('protectDirs (Tasks 6, 7)', () => {
  const opts = (over: Partial<Parameters<typeof protectDirs>[0]> = {}) => ({
    kind: 'wrap' as const, pathDirs: [], binary: [], cwd: '/w/repo', keepWritable: ['/w/repo', '/d/spill', '/h/.qoder/logs'], platform: 'linux' as const, ...over,
  })

  it('wrapped: every PATH dir, except one holding a path that has to stay writable, and /', () => {
    const got = protectDirs(opts({ pathDirs: ['/', '/w', '/w/repo', '/d', '/h', '/h/.qoder', '/h/.qoder/logs', '/usr/bin', '/h/.bun/bin', '/w/repo/bin'], binary: ['/opt/x'] }))
    expect(got).toEqual(['/usr/bin', '/h/.bun/bin', '/w/repo/bin', '/opt/x'])
  })

  it('the binary dirs are filtered the same way: a program in the session cwd\'s parent can\'t freeze cwd', () => {
    expect(protectDirs(opts({ binary: ['/w', '/opt/x'] }))).toEqual(['/opt/x'])
  })

  it('Codex: only dirs inside cwd need a read entry, the root is read-only anyway; the binary dirs stay', () => {
    const got = protectDirs(opts({ kind: 'translate', pathDirs: ['/usr/bin', '/w/repo/bin', '/w/repo/a/b'], binary: ['/opt/x'] }))
    expect(got).toEqual(['/w/repo/bin', '/w/repo/a/b', '/opt/x'])
  })

  it('de-duplicates', () => {
    expect(protectDirs(opts({ pathDirs: ['/a', '/a'], binary: ['/a'] }))).toEqual(['/a'])
  })

  it('compares realpath spellings too: a link to the parent of cwd still holds cwd', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-protect-')))
    try {
      const cwd = join(base, 'parent', 'repo')
      mkdirSync(cwd, { recursive: true })
      const link = join(base, 'link')
      symlinkSync(join(base, 'parent'), link)
      expect(protectDirs(opts({ pathDirs: [link], cwd, keepWritable: [cwd], platform: process.platform }))).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('treePolicy: rule roots in a worktree (Task 6 review)', () => {
  const policyOf = (cwd: string): ExecPolicy => ({
    denyRead: ['/cred'], persistence: [], dataDir: '/d', level: 'full',
    // deny read(hidden/**) 按 cwd 解析;deny read(/repo/abs/**) 是绝对路径,两棵树下都是同一个根
    ruleDenyRead: [`${cwd}/hidden`, '/repo/abs', '/elsewhere'],
    ruleDenyWrite: [`${cwd}/gen`],
    untranslatedRules: cwd === '/repo' ? 1 : 0,
    totalRules: 3,
  })

  it('in place: the session\'s policy, unchanged', () => {
    expect(treePolicy(policyOf, '/repo', '/repo')).toEqual(policyOf('/repo'))
  })

  it('in a worktree: both trees are covered, and an absolute root inside the session maps onto the worktree', () => {
    const p = treePolicy(policyOf, '/repo', '/wt/run_a')
    expect(p.ruleDenyRead.sort()).toEqual(['/elsewhere', '/repo/abs', '/repo/hidden', '/wt/run_a/abs', '/wt/run_a/hidden'].sort())
    expect(p.ruleDenyWrite.sort()).toEqual(['/repo/gen', '/wt/run_a/gen'].sort())
    expect(p.denyRead).toEqual(['/cred'])
  })

  it('the larger untranslated count wins: a rule one tree can\'t translate still has to ask', () => {
    expect(treePolicy(policyOf, '/repo', '/wt/run_a').untranslatedRules).toBe(1)
    expect(treePolicy(cwd => ({ ...policyOf(cwd), untranslatedRules: cwd === '/repo' ? 0 : 2 }), '/repo', '/wt/run_a').untranslatedRules).toBe(2)
  })
})
