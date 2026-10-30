import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../../kernel/kernel'
import type { Sessions } from '../../kernel/sessions'
import type { Plugin } from '../../kernel/pluginHost'
import type { ToolContext, ToolsService } from '../../lib/tools/types'
import toolsRegistry from '../tools-registry'
import { createToolsCoding } from './index'
import { deleteChecked } from './safeFs'

let root: string
let dataDir: string
let home: string
let cwd: string
let kernels: Kernel[] = []
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-patch-')))
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

const put = (rel: string, content: string) => {
  const p = join(cwd, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, content)
  return p
}
const text = (rel: string) => readFileSync(join(cwd, rel), 'utf8')
const wrap = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

async function boot() {
  let tools: ToolsService | undefined
  let sessions: Sessions | undefined
  const probe: Plugin = {
    manifest: { id: 'probe', version: '0', kernel: '^0.1.0', inject: ['tools'] },
    activate(ctx) {
      tools = ctx.services.get<ToolsService>('tools')
      sessions = ctx.services.get<Sessions>('sessions')
    },
  }
  const k = await createKernel({ dataDir, home, secrets: { osBackend: false }, plugins: [toolsRegistry, createToolsCoding(), probe] })
  kernels.push(k)
  const { sessionId } = (await k.handle('session.create', { commandId: `c${Math.random()}`, cwd, approvalMode: 'ask' })) as { sessionId: string }
  let n = 0
  const ctxOf = (): ToolContext => ({
    sessionId, turnId: 't1', callId: `call${++n}`, cwd: sessions!.get(sessionId)!.cwd!, spillDir: sessions!.spillDir(sessionId), signal: new AbortController().signal,
  })
  const call = (patch: string) => tools!.call('apply_patch', JSON.stringify({ patch }), ctxOf())
  const tool = tools!.list().find(t => t.name === 'apply_patch')!
  return { k, call, tool, ctxOf }
}

describe('apply_patch', () => {
  it('add, delete and update with two hunks → A / M / D lines', async () => {
    put('del.txt', 'bye\n')
    put('u.txt', 'a\nb\nc\nd\ne\n')
    const { call } = await boot()
    const r = await call(wrap('*** Add File: sub/new.txt', '+hi', '*** Delete File: del.txt', '*** Update File: u.txt', '@@', ' a', '-b', '+B', '@@', ' d', '-e', '+E'))
    expect(r.isError).toBeUndefined()
    expect(r.content.split('\n')).toEqual(['A sub/new.txt', 'D del.txt', 'M u.txt'])
    expect(text('sub/new.txt')).toBe('hi\n')
    expect(existsSync(join(cwd, 'del.txt'))).toBe(false)
    expect(text('u.txt')).toBe('a\nB\nc\nd\nE\n')
  })

  it('@@ context disambiguates a repeated block; trailing whitespace is tolerated', async () => {
    put('m.py', 'def bar():\n    return 1  \n\ndef foo():\n    return 1  \n')
    const { call } = await boot()
    const r = await call(wrap('*** Update File: m.py', '@@ def foo():', '-    return 1', '+    return 2'))
    expect(r.isError).toBeUndefined()
    expect(text('m.py')).toBe('def bar():\n    return 1  \n\ndef foo():\n    return 2\n')
  })

  it('move: target written, source removed; CRLF file stays CRLF', async () => {
    put('a.txt', 'one\r\ntwo\r\n')
    const { call } = await boot()
    const r = await call(wrap('*** Update File: a.txt', '*** Move to: dir/b.txt', '@@', '-two', '+TWO'))
    expect(r.isError).toBeUndefined()
    expect(r.content).toBe('M dir/b.txt')
    expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
    expect(text('dir/b.txt')).toBe('one\r\nTWO\r\n')
  })

  it('missing *** End Patch → isError', async () => {
    const { call } = await boot()
    const r = await call('*** Begin Patch\n*** Add File: x.txt\n+x')
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/End Patch/)
    expect(existsSync(join(cwd, 'x.txt'))).toBe(false)
  })

  it('second hunk fails to match → nothing changes on disk (the add is not created either)', async () => {
    put('u.txt', 'a\nb\nc\n')
    put('d.txt', 'keep\n')
    const { call } = await boot()
    const r = await call(wrap('*** Add File: new.txt', '+n', '*** Delete File: d.txt', '*** Update File: u.txt', '@@', '-a', '+A', '@@', '-nope', '+X'))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/第 2 个 hunk/)
    expect(text('u.txt')).toBe('a\nb\nc\n')
    expect(text('d.txt')).toBe('keep\n')
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
  })

  it('add over an existing file / delete a missing file → isError, nothing changes', async () => {
    put('e.txt', 'orig\n')
    const { call } = await boot()
    const a = await call(wrap('*** Add File: e.txt', '+new'))
    expect(a.isError).toBe(true)
    expect(a.content).toMatch(/已存在/)
    expect(text('e.txt')).toBe('orig\n')
    const d = await call(wrap('*** Delete File: gone.txt'))
    expect(d.isError).toBe(true)
    expect(d.content).toMatch(/不存在/)
  })

  it('permission lists one write per path, including the move target', async () => {
    const { tool, ctxOf } = await boot()
    const ctx = ctxOf()
    const args = { patch: wrap('*** Add File: n.txt', '+x', '*** Delete File: d.txt', '*** Update File: a.txt', '*** Move to: sub/b.txt', '@@', '-1', '+2') }
    expect(tool.permission(args, ctx)).toEqual(['n.txt', 'd.txt', 'a.txt', 'sub/b.txt'].map(p => ({ actor: 'tools', action: 'write', resource: join(ctx.cwd, p) })))
    expect(() => tool.permission({ patch: '*** Begin Patch\n' }, ctx)).toThrow(/End Patch/)
  })

  it('two spellings of the same file → isError', async () => {
    put('a.txt', 'x\n')
    const { call } = await boot()
    const r = await call(wrap('*** Delete File: a.txt', '*** Add File: ./a.txt', '+y'))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/多次/)
    expect(text('a.txt')).toBe('x\n')
  })

  it('move target outside cwd → denied, nothing changes', async () => {
    put('a.txt', '1\n')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const { call } = await boot()
    const r = await call(wrap('*** Update File: a.txt', `*** Move to: ${join(outside, 'b.txt')}`, '@@', '-1', '+2'))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/拒绝/)
    expect(text('a.txt')).toBe('1\n')
    expect(readdirSync(outside)).toEqual([])
  })

  it('move target through a symlink out of cwd → denied, nothing created outside', async () => {
    put('a.txt', '1\n')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(cwd, 'link'))
    const { call } = await boot()
    const r = await call(wrap('*** Update File: a.txt', '*** Move to: link/new/b.txt', '@@', '-1', '+2'))
    expect(r.isError).toBe(true)
    expect(text('a.txt')).toBe('1\n')
    expect(existsSync(join(outside, 'new'))).toBe(false)
  })

  it('a link swapped in after the permission check → run refuses before writing anything', async () => {
    put('a.txt', '1\n')
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const { tool, ctxOf } = await boot()
    const ctx = ctxOf()
    const args = { patch: wrap('*** Add File: ok.txt', '+x', '*** Update File: a.txt', '*** Move to: swap/b.txt', '@@', '-1', '+2') }
    tool.permission(args, ctx)
    symlinkSync(outside, join(cwd, 'swap'))
    await expect(tool.run(args, ctx)).rejects.toThrow(/变化/)
    expect(existsSync(join(cwd, 'ok.txt'))).toBe(false)
    expect(text('a.txt')).toBe('1\n')
    expect(readdirSync(outside)).toEqual([])
  })

  it('update or delete under .git is denied by the gate', async () => {
    put('.git/config', '[core]\n')
    const { call } = await boot()
    expect((await call(wrap('*** Delete File: .git/config'))).isError).toBe(true)
    expect(text('.git/config')).toBe('[core]\n')
  })

  it('deleteChecked refuses when the recheck fails or the parent resolves elsewhere', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'f'), 'x')
    const p = put('d/f', 'y')
    expect(() => deleteChecked(p, () => false)).toThrow()
    expect(existsSync(p)).toBe(true)
    symlinkSync(outside, join(cwd, 'l'))
    expect(() => deleteChecked(join(cwd, 'l/f'), () => true)).toThrow()
    expect(existsSync(join(outside, 'f'))).toBe(true)
    deleteChecked(p, () => true)
    expect(existsSync(p)).toBe(false)
  })

  describe('review fixes (Task 8 R1)', () => {
    it('I3: an Add under a regular file fails in the read phase; the valid Update is not written', async () => {
      put('u.txt', 'a\n')
      put('file.txt', 'f\n')
      const { call } = await boot()
      const r = await call(wrap('*** Update File: u.txt', '-a', '+A', '*** Add File: file.txt/x', '+x'))
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/不是目录/)
      expect(text('u.txt')).toBe('a\n')
      const m = await call(wrap('*** Add File: n.txt', '+n', '*** Update File: u.txt', '*** Move to: file.txt/deep/u.txt', '-a', '+A'))
      expect(m.isError).toBe(true)
      expect(existsSync(join(cwd, 'n.txt'))).toBe(false)
    })

    it('I3: a hard-linked Update source is refused before anything is written', async () => {
      put('u.txt', 'a\n')
      linkSync(join(cwd, 'u.txt'), join(root, 'other-link'))
      const { call } = await boot()
      const r = await call(wrap('*** Add File: n.txt', '+n', '*** Update File: u.txt', '-a', '+A'))
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/硬链接/)
      expect(existsSync(join(cwd, 'n.txt'))).toBe(false)
      expect(text('u.txt')).toBe('a\n')
    })

    it.skipIf(process.platform === 'win32')('FIFO / non-regular Update source → isError without blocking', async () => {
      execFileSync('mkfifo', [join(cwd, 'pipe')])
      const { call } = await boot()
      const r = await call(wrap('*** Update File: pipe', '-a', '+b'))
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/普通文件/)
    })

    it('M8: a non-UTF-8 file is refused and left byte-identical', async () => {
      const bytes = Buffer.from('caf\xe9\nx\n', 'latin1')
      writeFileSync(join(cwd, 'l1.txt'), bytes)
      const { call } = await boot()
      const r = await call(wrap('*** Update File: l1.txt', '-x', '+y'))
      expect(r.isError).toBe(true)
      expect(r.content).toMatch(/UTF-8/)
      expect(readFileSync(join(cwd, 'l1.txt')).equals(bytes)).toBe(true)
    })

    it('M7: Delete then Add of the same path rewrites it: one permission, reported as M', async () => {
      put('f.txt', 'old\n')
      const { call, tool, ctxOf } = await boot()
      const patch = wrap('*** Delete File: f.txt', '*** Add File: f.txt', '+new')
      const ctx = ctxOf()
      expect(tool.permission({ patch }, ctx)).toEqual([{ actor: 'tools', action: 'write', resource: join(ctx.cwd, 'f.txt') }])
      const r = await call(patch)
      expect(r.isError).toBeUndefined()
      expect(r.content).toBe('M f.txt')
      expect(text('f.txt')).toBe('new\n')
    })
  })
})
