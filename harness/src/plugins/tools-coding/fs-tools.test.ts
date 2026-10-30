import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Sessions } from '../../kernel/sessions'
import type { Plugin } from '../../kernel/pluginHost'
import { resolveToolPath } from '../../lib/fs/paths'
import type { ToolContext, ToolsService } from '../../lib/tools/types'
import toolsRegistry from '../tools-registry'
import { createToolsCoding, type GitRunner } from './index'
import { listFiles } from './files'
import { compileGlob, expandBraces, globMatcher } from './glob'
import { runGrep } from './grepWorker'
import { mkdirChecked, writeChecked } from './safeFs'

let root: string
let dataDir: string
let home: string
let cwd: string
let kernels: Kernel[] = []
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-coding-')))
  dataDir = join(root, 'data')
  home = join(root, 'home')
  cwd = join(home, 'repo')
  mkdirSync(dataDir)
  mkdirSync(cwd, { recursive: true })
})
afterEach(async () => {
  for (const k of kernels) await k.close().catch(() => {})
  kernels = []
  rmSync(root, { recursive: true, force: true })
})

/** 测试里的 git:家目录、全局配置都指向临时目录,不读系统配置 */
const gitEnv = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
const testGit: GitRunner = (args, dir) =>
  new Promise((res, rej) => execFile('git', args, { cwd: dir, env: gitEnv(), maxBuffer: 64 << 20 }, (err, out) => (err ? rej(err) : res(out))))

const put = (rel: string, content: string | Buffer, base = cwd) => {
  const p = join(base, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}

async function boot(opts: { sessionCwd?: string; grepTimeoutMs?: number } = {}) {
  let tools: ToolsService | undefined
  let sessions: Sessions | undefined
  const probe: Plugin = {
    manifest: { id: 'probe', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      tools = ctx.services.get<ToolsService>('tools')
      sessions = ctx.services.get<Sessions>('sessions')
    },
  }
  const k = await createKernel({
    dataDir, home, secrets: { osBackend: false },
    plugins: [toolsRegistry, createToolsCoding({ git: testGit, grepTimeoutMs: opts.grepTimeoutMs }), probe],
  })
  kernels.push(k)
  const { sessionId } = (await k.handle('session.create', { commandId: `c${Math.random()}`, cwd: opts.sessionCwd ?? cwd, approvalMode: 'ask' })) as { sessionId: string }
  let n = 0
  const ctxOf = (signal = new AbortController().signal): ToolContext => ({
    sessionId, turnId: 't1', callId: `call${++n}`, cwd: sessions!.get(sessionId)!.cwd!, spillDir: sessions!.spillDir(sessionId), signal,
  })
  const call = (name: string, args: unknown, ctx = ctxOf()) => tools!.call(name, JSON.stringify(args), ctx)
  return { k, tools: tools!, call, ctxOf }
}

describe('tools-coding registration', () => {
  it('registers read list glob grep write edit apply_patch shell with JSON-schema parameters', async () => {
    const { tools } = await boot()
    const names = tools.list().map(t => t.name).sort()
    expect(names).toEqual(['apply_patch', 'edit', 'glob', 'grep', 'list', 'read', 'shell', 'write'])
    for (const t of tools.list()) {
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.parameters).toMatchObject({ type: 'object' })
    }
  })

  it('every tool requests the resolved path (default .)', async () => {
    const { tools, ctxOf } = await boot()
    const ctx = ctxOf()
    const req = (name: string, args: object) => tools.list().find(t => t.name === name)!.permission(args, ctx)
    expect(req('read', { path: 'a.txt' })).toEqual([{ actor: 'tools', action: 'read', resource: join(ctx.cwd, 'a.txt') }])
    expect(req('list', {})).toEqual([{ actor: 'tools', action: 'read', resource: ctx.cwd }])
    expect(req('glob', { pattern: '*' })).toEqual([{ actor: 'tools', action: 'read', resource: ctx.cwd }])
    expect(req('grep', { pattern: 'x', path: 'src' })).toEqual([{ actor: 'tools', action: 'read', resource: join(ctx.cwd, 'src') }])
    expect(req('write', { path: 'n/x.txt', content: '' })).toEqual([{ actor: 'tools', action: 'write', resource: join(ctx.cwd, 'n/x.txt') }])
    expect(req('edit', { path: 'a.txt', old: 'a', new: 'b' })).toEqual([{ actor: 'tools', action: 'write', resource: join(ctx.cwd, 'a.txt') }])
  })
})

describe('read', () => {
  it('numbers lines; offset is 1-based; limit', async () => {
    put('a.txt', Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join('\n') + '\n')
    const { call } = await boot()
    const r = await call('read', { path: 'a.txt', offset: 3, limit: 2 })
    expect(r.isError).toBeUndefined()
    expect(r.content.split('\n').slice(0, 2)).toEqual(['     3\tl3', '     4\tl4'])
    expect(r.content).not.toContain('l5')
    expect(r.content).toMatch(/offset=5/)
    const all = await call('read', { path: 'a.txt' })
    expect(all.content.trimEnd().split('\n')).toHaveLength(10)
    expect(all.content.startsWith('     1\tl1\n')).toBe(true)
  })

  it('default limit is 2000 lines', async () => {
    put('big.txt', Array.from({ length: 2500 }, (_, i) => `x${i + 1}`).join('\n'))
    const { call } = await boot()
    const r = await call('read', { path: 'big.txt' })
    const numbered = r.content.split('\n').filter(l => /^\s*\d+\t/.test(l))
    expect(numbered).toHaveLength(2000)
    expect(numbered.at(-1)).toBe('  2000\tx2000')
    expect(r.content).toMatch(/offset=2001/)
  })

  it('cuts lines to 2000 chars', async () => {
    put('long.txt', 'y'.repeat(3000) + '\nshort\n')
    const { call } = await boot()
    const r = await call('read', { path: 'long.txt' })
    const first = r.content.split('\n')[0]
    expect(first.startsWith('     1\t' + 'y'.repeat(2000))).toBe(true)
    expect(first).not.toContain('y'.repeat(2001))
    expect(r.content).toContain('     2\tshort')
  })

  it('binary (NUL in the first 8 KB) → isError', async () => {
    put('bin.dat', Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]))
    const { call } = await boot()
    const r = await call('read', { path: 'bin.dat' })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/二进制/)
  })

  it('directory or missing file → isError', async () => {
    mkdirSync(join(cwd, 'd'))
    const { call } = await boot()
    expect((await call('read', { path: 'd' })).isError).toBe(true)
    expect((await call('read', { path: 'nope.txt' })).isError).toBe(true)
  })

  it('symlink out of cwd is denied and its content never shown', async () => {
    const outside = join(root, 'outside')
    put('secret', 'TOPSECRET', outside)
    symlinkSync(outside, join(cwd, 'link'))
    const { call } = await boot()
    const r = await call('read', { path: 'link/secret' })
    expect(r.isError).toBe(true)
    expect(r.content).not.toContain('TOPSECRET')
  })
})

describe('list', () => {
  it('one level, dirs suffixed /, sorted', async () => {
    put('b.txt', '')
    put('a.txt', '')
    put('sub/inner.txt', '')
    const { call } = await boot()
    const r = await call('list', {})
    expect(r.content.split('\n')).toEqual(['a.txt', 'b.txt', 'sub/'])
  })

  it('caps at 500 entries', async () => {
    for (let i = 0; i < 600; i++) writeFileSync(join(cwd, `f${String(i).padStart(3, '0')}`), '')
    const { call } = await boot()
    const r = await call('list', { path: '.' })
    const entries = r.content.split('\n').filter(l => /^f\d{3}$/.test(l))
    expect(entries).toHaveLength(500)
    expect(entries[0]).toBe('f000')
    expect(r.content).toMatch(/600/)
  })
})

describe('compileGlob', () => {
  it.each([
    ['*.ts', 'a.ts', true], ['*.ts', 'a/b.ts', false], ['**/*.ts', 'a/b/c.ts', true], ['**/*.ts', 'c.ts', true],
    ['src/**', 'src/a/b', true], ['src/**', 'srcx/a', false], ['a?.js', 'ab.js', true], ['a?.js', 'a/.js', false],
    ['*.{ts,tsx}', 'x.tsx', true], ['*.{ts,tsx}', 'x.js', false], ['[ab].txt', 'b.txt', true], ['[!ab].txt', 'b.txt', false],
    ['[!ab].txt', 'c.txt', true], ['a.b', 'axb', false], ['(x)+', '(x)+', true], ['src/**/test/*.ts', 'src/test/a.ts', true],
  ])('%s vs %s → %s', (pat, path, want) => {
    expect(compileGlob(pat)(path)).toBe(want)
  })
})

describe('listFiles / glob', () => {
  it('in a git repo uses ls-files: ignored files excluded, untracked included', async () => {
    await testGit(['init', '-q'], cwd)
    put('.gitignore', 'ignored.txt\nbuild/\n')
    put('tracked.ts', '')
    put('untracked.ts', '')
    put('ignored.txt', '')
    put('build/out.ts', '')
    await testGit(['add', 'tracked.ts'], cwd)
    const { files } = await listFiles(cwd, { signal: new AbortController().signal, max: 20000, git: testGit })
    expect(files.sort()).toEqual(['.gitignore', 'tracked.ts', 'untracked.ts'])
    const { call } = await boot()
    const r = await call('glob', { pattern: '**/*' })
    expect(r.content.split('\n').sort()).toEqual(['.gitignore', 'tracked.ts', 'untracked.ts'])
  })

  it('outside git walks the tree and skips node_modules and .git', async () => {
    put('src/a.ts', '')
    put('node_modules/pkg/index.ts', '')
    put('.git/config.ts', '')
    put('deep/x/y.ts', '')
    const { files, truncated } = await listFiles(cwd, { signal: new AbortController().signal, max: 20000, git: testGit })
    expect(files.sort()).toEqual(['deep/x/y.ts', 'src/a.ts'])
    expect(truncated).toBe(false)
    const capped = await listFiles(cwd, { signal: new AbortController().signal, max: 1, git: testGit })
    expect(capped).toMatchObject({ files: [expect.any(String)], truncated: true })
  })

  it('glob sorts by mtime desc; a pattern without / matches at any depth; path narrows', async () => {
    const t = Date.now() / 1000
    utimesSync(put('old.ts', ''), t - 300, t - 300)
    utimesSync(put('sub/new.ts', ''), t, t)
    utimesSync(put('mid.ts', ''), t - 100, t - 100)
    put('x.js', '')
    const { call } = await boot()
    expect((await call('glob', { pattern: '*.ts' })).content.split('\n')).toEqual(['sub/new.ts', 'mid.ts', 'old.ts'])
    expect((await call('glob', { pattern: '*.ts', path: 'sub' })).content.split('\n')).toEqual(['sub/new.ts'])
    expect((await call('glob', { pattern: '*.none' })).isError).toBeUndefined()
  })

  it('glob caps at 200', async () => {
    for (let i = 0; i < 250; i++) put(`g/f${i}.txt`, '')
    const { call } = await boot()
    const r = await call('glob', { pattern: '**/*.txt' })
    expect(r.content.split('\n').filter(l => l.endsWith('.txt'))).toHaveLength(200)
    expect(r.content).toMatch(/250/)
  })

  it('glob and grep skip credential paths when cwd = $HOME', async () => {
    put('.ssh/id_rsa', 'PRIVATEKEY', home)
    put('notes.txt', 'PRIVATEKEY in notes', home)
    const { call } = await boot({ sessionCwd: home })
    const g = await call('glob', { pattern: '**/*' })
    expect(g.content).not.toContain('.ssh')
    const r = await call('grep', { pattern: 'PRIVATEKEY' })
    expect(r.content).toContain('notes.txt:1:')
    expect(r.content).not.toContain('id_rsa')
  })
})

describe('grep', () => {
  it('path:line: text; ignoreCase; glob filter', async () => {
    put('a.ts', 'const Foo = 1\nnothing\nfoo()\n')
    put('b.js', 'foo js\n')
    const { call } = await boot()
    expect((await call('grep', { pattern: 'foo' })).content.split('\n').sort()).toEqual(['a.ts:3: foo()', 'b.js:1: foo js'])
    expect((await call('grep', { pattern: 'foo', ignoreCase: true, glob: '*.ts' })).content.split('\n')).toEqual(['a.ts:1: const Foo = 1', 'a.ts:3: foo()'])
    expect((await call('grep', { pattern: 'foo', path: 'b.js' })).content).toBe('b.js:1: foo js')
    expect((await call('grep', { pattern: 'zzz' })).isError).toBeUndefined()
  })

  it('caps at 200 matches', async () => {
    put('many.txt', Array.from({ length: 500 }, (_, i) => `hit ${i}`).join('\n'))
    const { call } = await boot()
    const r = await call('grep', { pattern: '^hit' })
    expect(r.content.split('\n').filter(l => l.startsWith('many.txt:'))).toHaveLength(200)
    expect(r.content).toMatch(/200/)
  })

  it('invalid regex → isError', async () => {
    const { call } = await boot()
    const r = await call('grep', { pattern: '(' })
    expect(r.isError).toBe(true)
  })

  it('worker: skips files over 2 MB and files with NUL in the first 8 KB; lines cut at maxLine', async () => {
    const big = put('big.txt', 'needle\n' + 'x'.repeat(2 * 1024 * 1024))
    const bin = put('bin.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.from([0]), Buffer.from('\nneedle')]))
    const lateNul = put('late.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.alloc(9000, 0x20), Buffer.from([0])]))
    const long = put('long.txt', 'needle' + 'z'.repeat(5000))
    const r = await runGrep({ files: [big, bin, lateNul, long], base: cwd, pattern: 'needle', flags: '', maxMatches: 200, maxLine: 2000 }, { signal: new AbortController().signal })
    expect(r.timedOut).toBe(false)
    expect(r.matches.map(m => m.slice(0, m.indexOf(':')))).toEqual(['late.txt', 'long.txt'])
    const longHit = r.matches[1]
    expect(longHit.length).toBe('long.txt:1: '.length + 2000)
  })

  it('Review Focus 6: catastrophic regex times out in the worker; the kernel stays responsive', async () => {
    put('evil.txt', 'a'.repeat(5000) + 'b\n')
    const { call, k } = await boot({ grepTimeoutMs: 500 })
    const t0 = Date.now()
    let settled = false
    const pending = call('grep', { pattern: '(a+)+$' }).finally(() => (settled = true))
    await new Promise(r => setTimeout(r, 100)) // 线程已经卡在回溯里
    const s0 = Date.now()
    await k.handle('status', {})
    expect(Date.now() - s0).toBeLessThan(200)
    expect(settled).toBe(false) // status 回来时 grep 还在跑:量的是忙着的内核
    const r = await pending
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/超时/)
    expect(Date.now() - t0).toBeLessThan(5000)
    // 线程已终止,之后照常可用
    put('ok.txt', 'fine\n')
    expect((await call('grep', { pattern: 'fine' })).content).toBe('ok.txt:1: fine')
  })

  it('abort terminates the worker', async () => {
    const f = put('evil.txt', 'a'.repeat(5000) + 'b\n')
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const t0 = Date.now()
    const r = await runGrep({ files: [f], base: cwd, pattern: '(a+)+$', flags: '', maxMatches: 200, maxLine: 2000 }, { signal: ac.signal, timeoutMs: 30_000 })
    expect(r.aborted).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
  })
})

describe('write', () => {
  it('creates parent dirs and overwrites', async () => {
    const { call } = await boot()
    const r = await call('write', { path: 'a/b/c.txt', content: 'hello' })
    expect(r.isError).toBeUndefined()
    expect(readFileSync(join(cwd, 'a/b/c.txt'), 'utf8')).toBe('hello')
    await call('write', { path: 'a/b/c.txt', content: 'bye' })
    expect(readFileSync(join(cwd, 'a/b/c.txt'), 'utf8')).toBe('bye')
  })

  it('symlink escape → isError, nothing created outside', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(cwd, 'link'))
    const { call } = await boot()
    const r = await call('write', { path: 'link/new/x.txt', content: 'x' })
    expect(r.isError).toBe(true)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('a link swapped in after the permission check → run refuses, nothing created outside', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const { tools, ctxOf } = await boot()
    const write = tools.list().find(t => t.name === 'write')!
    const ctx = ctxOf()
    const args = { path: 'swap/new/x.txt', content: 'x' }
    expect(write.permission(args, ctx)[0].resource).toBe(join(ctx.cwd, 'swap/new/x.txt'))
    symlinkSync(outside, join(cwd, 'swap'))
    await expect(write.run(args, ctx)).rejects.toThrow(/变化/)
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('mkdirChecked / writeChecked: swapped ancestor or final link is not followed', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const approved = resolveToolPath(cwd, 'sw/b/x.txt')
    symlinkSync(outside, join(cwd, 'sw'))
    expect(() => mkdirChecked(join(approved, '..'))).toThrow()
    expect(existsSync(join(outside, 'b'))).toBe(false)
    // 最近存在的祖先是外面的真目录(经上层链接到达):lstat 是目录,只有 realpath 核对拦得住
    mkdirSync(join(outside, 'real'))
    const deeper = resolveToolPath(cwd, 'sw2/real/c/x.txt')
    symlinkSync(outside, join(cwd, 'sw2'))
    expect(() => mkdirChecked(join(deeper, '..'))).toThrow()
    expect(existsSync(join(outside, 'real/c'))).toBe(false)
    writeFileSync(join(outside, 'target'), 'orig')
    symlinkSync(join(outside, 'target'), join(cwd, 'final'))
    expect(() => writeChecked(join(cwd, 'final'), 'pwned', () => true)).toThrow()
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('orig')
    expect(() => writeChecked(join(cwd, 'ok/y.txt'), 'no', () => false)).toThrow()
    expect(existsSync(join(cwd, 'ok/y.txt'))).toBe(false)
  })

  it('write under .git is denied by the gate', async () => {
    mkdirSync(join(cwd, '.git'))
    const { call } = await boot()
    expect((await call('write', { path: '.git/hooks/pre-commit', content: 'x' })).isError).toBe(true)
    expect(existsSync(join(cwd, '.git/hooks'))).toBe(false)
  })
})

describe('edit', () => {
  it('unique match replaced; $ patterns in new stay literal', async () => {
    const f = put('a.ts', 'one\ntwo\nthree\n')
    const { call } = await boot()
    const r = await call('edit', { path: 'a.ts', old: 'two', new: '$&2$$' })
    expect(r.isError).toBeUndefined()
    expect(readFileSync(f, 'utf8')).toBe('one\n$&2$$\nthree\n')
  })

  it('multiple matches without replaceAll → isError with the count; replaceAll replaces all', async () => {
    const f = put('a.ts', 'x\nx\nx\n')
    const { call } = await boot()
    const r = await call('edit', { path: 'a.ts', old: 'x', new: 'y' })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/3/)
    expect(readFileSync(f, 'utf8')).toBe('x\nx\nx\n')
    expect((await call('edit', { path: 'a.ts', old: 'x', new: 'y', replaceAll: true })).isError).toBeUndefined()
    expect(readFileSync(f, 'utf8')).toBe('y\ny\ny\n')
  })

  it('retries with line-number prefixes stripped', async () => {
    const f = put('a.ts', 'alpha\n  beta\ngamma\n')
    const { call } = await boot()
    const r = await call('edit', { path: 'a.ts', old: '     2\t  beta\n     3\tgamma', new: '  BETA\ngamma' })
    expect(r.isError).toBeUndefined()
    expect(readFileSync(f, 'utf8')).toBe('alpha\n  BETA\ngamma\n')
  })

  it('not found → isError with the nearest window (±3 lines around the first line containing old\'s first trimmed line)', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    lines[9] = '    function target() {'
    const f = put('a.ts', lines.join('\n'))
    const { call } = await boot()
    const r = await call('edit', { path: 'a.ts', old: '  function target() {\n    wrong body', new: 'x' })
    expect(r.isError).toBe(true)
    expect(r.content).toContain('     7\tline 7')
    expect(r.content).toContain('    10\t    function target() {')
    expect(r.content).toContain('    13\tline 13')
    expect(r.content).not.toContain('line 6\n')
    expect(r.content).not.toContain('line 14')
    expect(readFileSync(f, 'utf8')).toBe(lines.join('\n'))
    const none = await call('edit', { path: 'a.ts', old: 'absent', new: 'x' })
    expect(none.isError).toBe(true)
  })

  it('empty old or missing file → isError', async () => {
    put('a.ts', 'x')
    const { call } = await boot()
    expect((await call('edit', { path: 'a.ts', old: '', new: 'y' })).isError).toBe(true)
    expect((await call('edit', { path: 'missing.ts', old: 'x', new: 'y' })).isError).toBe(true)
  })
})

describe('review fixes (Task 7 R1)', () => {
  it('I1: a tracked dir replaced by a symlink to outside / to $HOME/.ssh is skipped by glob and grep', async () => {
    const outside = join(root, 'outside')
    put('f.txt', 'OUTSIDE_SECRET', outside)
    put('.ssh/id_rsa', 'SSH_SECRET', home)
    await testGit(['init', '-q'], cwd)
    put('d/f.txt', 'inside')
    put('k/id_rsa', 'inside')
    put('ok.txt', 'OUTSIDE_SECRET SSH_SECRET mention')
    await testGit(['add', '.'], cwd)
    rmSync(join(cwd, 'd'), { recursive: true })
    rmSync(join(cwd, 'k'), { recursive: true })
    symlinkSync(outside, join(cwd, 'd'))
    symlinkSync(join(home, '.ssh'), join(cwd, 'k'))
    expect((await testGit(['ls-files', '-co', '--exclude-standard'], cwd)).split('\n')).toEqual(expect.arrayContaining(['d/f.txt', 'k/id_rsa']))
    const { call } = await boot()
    const g = await call('glob', { pattern: '**/*' })
    expect(g.content.split('\n').sort()).toEqual(['ok.txt'])
    const r = await call('grep', { pattern: 'SECRET' })
    expect(r.content).toBe('ok.txt:1: OUTSIDE_SECRET SSH_SECRET mention')
    const direct = await runGrep({ files: [join(cwd, 'd/f.txt'), join(cwd, 'k/id_rsa')], base: cwd, pattern: 'SECRET', flags: '', maxMatches: 200, maxLine: 2000 }, { signal: new AbortController().signal })
    expect(direct.matches).toEqual([]) // worker 也再核对一次
  })

  it('I2: the 41-char brace bomb returns within 1 s and status stays fast', async () => {
    const bomb = '{*,*}{*,*}{*,*}{*,*}{*,*}{*,*}{*,*}{*,*}x'
    expect(bomb).toHaveLength(41)
    for (let i = 0; i < 50; i++) put(`n/${'q'.repeat(30)}${i}`, '')
    const { call, k } = await boot()
    const t0 = Date.now()
    const pending = call('glob', { pattern: bomb })
    const s0 = Date.now()
    await k.handle('status', {})
    expect(Date.now() - s0).toBeLessThan(200)
    const r = await pending
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/64/)
    const g = await call('grep', { pattern: 'x', glob: bomb })
    expect(g.isError).toBe(true)
  })

  it('I2: matching is linear — many stars against long names, the cap, dedupe', () => {
    const t0 = Date.now()
    const m = compileGlob('*a*a*a*a*a*a*a*a*a*a*a*a*x')
    for (let i = 0; i < 200; i++) expect(m('a'.repeat(40 + (i % 5)))).toBe(false)
    const deep = compileGlob('**/**/**/**/**/**/**/**/z')
    expect(deep(Array.from({ length: 60 }, () => 'a').join('/'))).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
    expect(expandBraces('{a,b}{c,d}{e,f}')).toHaveLength(8)
    expect(expandBraces('{*,*}{*,*}')).toEqual(['**'])
    expect(() => expandBraces('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}')).toThrow(/64/)
    expect(globMatcher('{src,lib}/*.ts')('lib/a.ts')).toBe(true)
    expect(globMatcher('*.{a,b{c,d}}')('x.bd')).toBe(true)
    expect(globMatcher('[a-c]?.txt')('bz.txt')).toBe(true)
    expect(globMatcher('[]]x')(']x')).toBe(true)
    expect(globMatcher('\\*.txt')('*.txt')).toBe(true)
    expect(globMatcher('\\*.txt')('a.txt')).toBe(false)
  })

  it('M1: listFiles passes the abort signal and a 10 s timeout to git', async () => {
    const seen: unknown[] = []
    const ac = new AbortController()
    await listFiles(cwd, { signal: ac.signal, max: 10, git: async (_a, _c, o) => (seen.push(o), '') })
    expect(seen).toEqual([{ signal: ac.signal, timeoutMs: 10_000 }])
  })

  it('M2: grep shows paths outside cwd (spillDir) as absolute', async () => {
    const { call, ctxOf } = await boot()
    const ctx = ctxOf()
    const f = put('c1-read.txt', 'spilled line\n', ctx.spillDir)
    const r = await call('grep', { pattern: 'spilled', path: f }, ctx)
    expect(r.content).toBe(`${realpathSync(f)}:1: spilled line`)
  })

  it('M3: exactly 200 matches → no cap note', async () => {
    put('many.txt', Array.from({ length: 200 }, (_, i) => `hit ${i}`).join('\n'))
    const { call } = await boot()
    const r = await call('grep', { pattern: '^hit' })
    expect(r.content.split('\n')).toHaveLength(200)
    expect(r.content).not.toMatch(/上限/)
  })

  it('M4: overlapping occurrences count as not unique', async () => {
    const f = put('a.ts', '}\n}\n}')
    const { call } = await boot()
    const r = await call('edit', { path: 'a.ts', old: '}\n}', new: 'X' })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/2 次/)
    expect(readFileSync(f, 'utf8')).toBe('}\n}\n}')
  })

  it('M7: write refuses a file with another hard link and leaves it untouched', async () => {
    const outside = join(root, 'outside')
    const target = put('cred', 'orig', outside)
    linkSync(target, join(cwd, 'hl'))
    const { call } = await boot()
    const r = await call('write', { path: 'hl', content: 'pwned' })
    expect(r.isError).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('orig')
  })

  it('M8: edit refuses files over 10 MB', async () => {
    put('huge.txt', 'a' + 'b'.repeat(10 * 1024 * 1024))
    const { call } = await boot()
    const r = await call('edit', { path: 'huge.txt', old: 'a', new: 'c' })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/过大/)
  })

  it.skipIf(process.platform === 'win32')('Task 9 carry: read / edit of a FIFO → isError without blocking; the kernel stays responsive', async () => {
    execFileSync('mkfifo', [join(cwd, 'pipe')])
    const { k, call } = await boot()
    const t0 = Date.now()
    const r = await call('read', { path: 'pipe' })
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/普通文件/)
    const e = await call('edit', { path: 'pipe', old: 'a', new: 'b' })
    expect(e.isError).toBe(true)
    expect(e.content).toMatch(/普通文件/)
    await k.handle('status', {})
    expect(Date.now() - t0).toBeLessThan(1000)
  }, 3000)
})
