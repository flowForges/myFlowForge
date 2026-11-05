import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nullLogger } from '../../kernel/log'
import { integrityOf, walkTree } from '../../lib/plugins/tree'
import type { PluginConsent } from '../../protocol/index'
import { PluginStore, versionDirName, type InstalledRecord } from './store'

const hex = 'a'.repeat(64)
const consent = (id: string): PluginConsent => ({
  id, version: '1.0.0', format: 'claude', claimed: { name: id, description: '' }, source: { kind: 'path', path: '/x' }, integrity: `sha256:${hex}`, files: 0, bytes: 0,
  skills: [], commands: [], mcp: [], config: [], notRun: { hooks: [], agents: [], bin: [], monitors: [], workflows: [], lsp: [], other: [], remoteMcp: [], scripts: [] }, warnings: [], truncatedSections: [],
})
const record = (id: string, over: Partial<InstalledRecord> = {}): InstalledRecord => ({
  id, version: '1.0.0', format: 'claude', enabled: true, source: { kind: 'path', path: '/x' }, integrity: `sha256:${hex}`, installedAt: 1, grants: { servers: {} }, settings: {}, secretKeys: [], state: 'ok',
  dir: `${id}/${hex.slice(0, 12)}`, consent: consent(id), textHashes: {}, config: [], servers: [], ...over,
})

let root: string
let dataDir: string
let code: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-store-')))
  dataDir = join(root, 'data')
  code = `${dataDir}-plugins`
  mkdirSync(dataDir)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const open = () => PluginStore.open({ dataDir }, nullLogger)
const file = () => join(dataDir, 'plugins', 'plugin-manager', 'installed.json')
const seed = (...recs: InstalledRecord[]) => {
  const s = open()
  for (const r of recs) {
    mkdirSync(join(code, r.dir), { recursive: true })
    s.put(r)
  }
  s.save()
}

describe('PluginStore', () => {
  it('opening with no plugins creates nothing at all', () => {
    const s = open()
    expect(s.list()).toEqual([])
    expect(s.problems).toEqual([])
    expect(existsSync(code)).toBe(false)
    expect(existsSync(join(dataDir, 'plugin-data'))).toBe(false)
    expect(existsSync(file())).toBe(false)
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('save is 0600, leaves no temp file, and survives a reopen', () => {
    seed(record('a'))
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dataDir, 'plugins', 'plugin-manager'))).toEqual(['installed.json'])
    expect(open().get('a')?.dir).toBe(`a/${hex.slice(0, 12)}`)
  })

  it('a save with no records removes the file: nothing left to compare', () => {
    seed(record('a'))
    const s = open()
    s.remove('a')
    s.save()
    expect(existsSync(file())).toBe(false)
  })

  it('a failed save keeps the old file', () => {
    seed(record('a'))
    const before = readFileSync(file())
    const s = open()
    s.put(record('b'))
    mkdirSync(`${file()}.tmp`) // open(tmp) 是目录:写不了
    expect(() => s.save()).toThrow()
    expect(readFileSync(file())).toEqual(before)
    expect(existsSync(`${file()}.tmp`)).toBe(false)
  })

  it.each([
    ['not JSON', '{oops'],
    ['wrong version', JSON.stringify({ version: 9, plugins: [] })],
    ['record with a dir that points elsewhere', JSON.stringify({ version: 1, plugins: [record('a', { dir: '../../etc' })] })],
    ['record with a bad id', JSON.stringify({ version: 1, plugins: [record('A/../b')] })],
    ['record with a bad secret key', JSON.stringify({ version: 1, plugins: [record('a', { secretKeys: ['b/KEY'] })] })],
    ['duplicate ids', JSON.stringify({ version: 1, plugins: [record('a'), record('a')] })],
  ])('corrupt installed.json (%s): set aside, nothing enabled, store_recovered', (_n, text) => {
    mkdirSync(join(dataDir, 'plugins', 'plugin-manager'), { recursive: true })
    writeFileSync(file(), text)
    const s = open()
    expect(s.list()).toEqual([])
    expect(s.problems).toContain('store_recovered')
    expect(existsSync(file())).toBe(false)
    const kept = readdirSync(join(dataDir, 'plugins', 'plugin-manager')).filter(n => n.startsWith('installed.json.bad-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dataDir, 'plugins', 'plugin-manager', kept[0]), 'utf8')).toBe(text)
  })

  it('the open that recovers keeps code and data; a later clean open reconciles them', () => {
    seed(record('a'))
    mkdirSync(join(dataDir, 'plugin-data', 'a', 'srv'), { recursive: true })
    mkdirSync(join(code, '.staging', 'old'), { recursive: true })
    writeFileSync(file(), '{oops')
    open()
    expect(existsSync(join(code, 'a'))).toBe(true)
    expect(existsSync(join(dataDir, 'plugin-data', 'a', 'srv'))).toBe(true)
    expect(existsSync(join(code, '.staging'))).toBe(false)
    open()
    expect(existsSync(code)).toBe(false)
    expect(existsSync(join(dataDir, 'plugin-data'))).toBe(false)
  })

  describe('reconcile on open', () => {
    it('drops staging, unknown ids, unknown versions and unknown data; keeps what the record names', () => {
      seed(record('a'))
      const keep = join(code, 'a', hex.slice(0, 12), 'SKILL.md')
      writeFileSync(keep, 'x')
      mkdirSync(join(code, '.staging', 'st1'), { recursive: true })
      mkdirSync(join(code, 'ghost', 'b'.repeat(12)), { recursive: true })
      mkdirSync(join(code, 'a', 'c'.repeat(12)), { recursive: true })
      mkdirSync(join(dataDir, 'plugin-data', 'a', 'srv'), { recursive: true })
      mkdirSync(join(dataDir, 'plugin-data', 'ghost', 'srv'), { recursive: true })
      open()
      expect(existsSync(keep)).toBe(true)
      expect(readdirSync(code)).toEqual(['a'])
      expect(readdirSync(join(code, 'a'))).toEqual([hex.slice(0, 12)])
      expect(readdirSync(join(dataDir, 'plugin-data'))).toEqual(['a'])
    })

    it('a crash between the rename and the record: the new dir is gone, the old one stays', () => {
      seed(record('a'))
      const planted = join(code, 'a', 'd'.repeat(12))
      mkdirSync(planted)
      writeFileSync(join(planted, 'new'), 'x')
      const s = open()
      expect(existsSync(planted)).toBe(false)
      expect(s.get('a')?.dir).toBe(`a/${hex.slice(0, 12)}`)
      expect(existsSync(join(code, 'a', hex.slice(0, 12)))).toBe(true)
    })

    it('a directory planted at the store root before any install is emptied and removed', () => {
      mkdirSync(join(code, 'evil', 'b'.repeat(12)), { recursive: true })
      writeFileSync(join(code, 'evil', 'b'.repeat(12), 'x'), 'planted')
      mkdirSync(join(code, '.staging', 'st'), { recursive: true })
      open()
      expect(existsSync(code)).toBe(false)
    })

    it('a symlink planted at the store root is removed, and its target is not touched', () => {
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(join(elsewhere, 'precious'), { recursive: true })
      writeFileSync(join(elsewhere, 'precious', 'f'), 'keep')
      symlinkSync(elsewhere, code)
      open()
      expect(existsSync(code)).toBe(false)
      expect(readFileSync(join(elsewhere, 'precious', 'f'), 'utf8')).toBe('keep')
    })

    it('a file planted at the store root is removed', () => {
      writeFileSync(code, 'x')
      open()
      expect(existsSync(code)).toBe(false)
    })

    it('a symlink at <id> or at .staging is removed, not followed', () => {
      seed(record('a'))
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'f'), 'keep')
      symlinkSync(elsewhere, join(code, '.staging'))
      rmSync(join(code, 'a'), { recursive: true })
      symlinkSync(elsewhere, join(code, 'a'))
      open()
      expect(existsSync(join(code, '.staging'))).toBe(false)
      expect(readFileSync(join(elsewhere, 'f'), 'utf8')).toBe('keep')
      expect(existsSync(join(code, 'a'))).toBe(false)
    })
  })

  describe('ensure', () => {
    it('creates real directories, replacing a link planted after open', () => {
      const s = open()
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, code)
      s.ensure()
      expect(statSync(code).isDirectory()).toBe(true)
      expect(readdirSync(elsewhere)).toEqual([])
      expect(readdirSync(code)).toEqual(['.staging'])
    })

    it('reconciles a directory planted after open, before the first use', () => {
      const s = open()
      mkdirSync(join(code, 'evil', 'b'.repeat(12)), { recursive: true })
      s.ensure()
      expect(readdirSync(code)).toEqual(['.staging'])
    })

    it('tidy removes the empty root and the next ensure treats a plant as foreign again', () => {
      const s = open()
      s.ensure()
      s.tidy()
      expect(existsSync(code)).toBe(false)
      mkdirSync(join(code, 'evil'), { recursive: true })
      s.ensure()
      expect(readdirSync(code)).toEqual(['.staging'])
    })

    it('tidy leaves a root that holds a plugin', () => {
      seed(record('a'))
      const s = open()
      s.ensure()
      s.tidy()
      expect(readdirSync(code)).toEqual(['a'])
    })
  })

  describe('paths', () => {
    it('codeDir, stagingDir, versionDir and dataDirOf', () => {
      const s = open()
      const r = record('a')
      expect(s.codeDir('a')).toBe(join(code, 'a'))
      expect(s.versionDir(r)).toBe(join(code, 'a', hex.slice(0, 12)))
      expect(s.stagingDir('st1')).toBe(join(code, '.staging', 'st1'))
      expect(s.dataDirOf('a', 'srv')).toBe(join(dataDir, 'plugin-data', 'a', 'srv'))
    })

    it.each([['A/b', 'srv'], ['..', 'srv'], ['a', '../b'], ['a', 'x/y'], ['a', '']])('dataDirOf(%s, %s) refuses a shape that could leave its own directory', (id, server) => {
      expect(() => open().dataDirOf(id, server)).toThrow()
    })

    it('M17: two servers of one plugin never share a data dir, and a case-fold pair is refused', () => {
      const s = open()
      s.put(record('a', { servers: [{ name: 'Foo', configRefs: [] }, { name: 'foo', configRefs: [] }, { name: 'bar', configRefs: [] }] }))
      expect(s.dataDirOf('a', 'bar')).not.toBe(s.dataDirOf('a', 'baz'))
      expect(() => s.dataDirOf('a', 'Foo')).toThrow()
      expect(() => s.dataDirOf('a', 'foo')).toThrow()
    })
  })

  describe('verify', () => {
    const build = (s: PluginStore) => {
      const built = join(root, 'built')
      mkdirSync(built)
      writeFileSync(join(built, 'f'), 'x')
      const w = walkTree(built)
      if (!w.ok) throw new Error('walk')
      const integrity = integrityOf(built, w.files)
      const dir = join(code, 'a', versionDirName(integrity))
      mkdirSync(join(code, 'a'), { recursive: true })
      renameSync(built, dir)
      const rec = record('a', { integrity, dir: `a/${versionDirName(integrity)}` })
      s.put(rec)
      return { dir, rec }
    }
    it('true for the recorded tree; false for a changed byte, an added file, a link or a missing dir', () => {
      const s = open()
      const { dir, rec } = build(s)
      expect(s.verify(rec)).toBe(true)
      writeFileSync(join(dir, 'f'), 'y')
      expect(s.verify(rec)).toBe(false)
      writeFileSync(join(dir, 'f'), 'x')
      expect(s.verify(rec)).toBe(true)
      writeFileSync(join(dir, 'g'), '')
      expect(s.verify(rec)).toBe(false)
      rmSync(join(dir, 'g'))
      symlinkSync('/etc/hosts', join(dir, 'g'))
      expect(s.verify(rec)).toBe(false)
      rmSync(dir, { recursive: true })
      expect(s.verify(rec)).toBe(false)
    })
    it('false when <id> is a link to a directory holding the right bytes', () => {
      const s = open()
      const { dir, rec } = build(s)
      expect(s.verify(rec)).toBe(true)
      const moved = join(root, 'moved')
      renameSync(join(code, 'a'), moved)
      symlinkSync(moved, join(code, 'a'))
      expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('x') // 路径照样读得到,但这不是存储里的
      expect(s.verify(rec)).toBe(false)
    })
  })
})
