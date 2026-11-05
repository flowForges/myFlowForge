import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

  it('a save with no records keeps an empty file: it says the store is ours until tidy finds nothing left', () => {
    seed(record('a'))
    const s = open()
    s.remove('a')
    s.save()
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, plugins: [] })
    s.tidy()
    expect(existsSync(file())).toBe(true) // 代码目录还在
    s.removeFiles('a')
    s.tidy()
    expect(existsSync(file())).toBe(false)
    expect(existsSync(code)).toBe(false)
  })

  it('an empty record file with directories: they are ours and unknown, so they go', () => {
    seed(record('a'))
    const s = open()
    s.remove('a')
    s.save()
    const again = open()
    expect(again.problems).toEqual([])
    expect(existsSync(code)).toBe(false)
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

  describe('I1: nothing is deleted on a guess', () => {
    const plant = () => {
      seed(record('a'))
      mkdirSync(join(dataDir, 'plugin-data', 'a', 'srv'), { recursive: true })
      mkdirSync(join(code, '.staging', 'old'), { recursive: true })
    }
    const kept = () => existsSync(join(code, 'a')) && existsSync(join(dataDir, 'plugin-data', 'a', 'srv'))

    it('corrupt: code and data stay on every boot, and every boot reports store_recovered', () => {
      plant()
      writeFileSync(file(), '{oops')
      for (let boot = 0; boot < 3; boot++) {
        const s = open()
        expect(s.problems).toEqual(['store_recovered'])
        expect(kept()).toBe(true)
        expect(existsSync(join(code, '.staging'))).toBe(false)
        s.ensure()
        expect(kept()).toBe(true)
        s.tidy()
      }
    })

    it('a read error is not corruption: the file stays where it is, whole, and comes back when readable', () => {
      plant()
      const bytes = readFileSync(file())
      chmodSync(file(), 0o000)
      try {
        for (let boot = 0; boot < 2; boot++) {
          const s = open()
          expect(s.list()).toEqual([])
          expect(s.problems).toEqual(['store_recovered'])
          expect(s.unreadable).toBe(true)
          expect(kept()).toBe(true)
          expect(() => s.save()).toThrow()
          s.tidy()
          expect(readdirSync(join(dataDir, 'plugins', 'plugin-manager')).filter(n => n.includes('.bad-'))).toEqual([])
        }
      } finally {
        chmodSync(file(), 0o600)
      }
      expect(readFileSync(file())).toEqual(bytes)
      const s = open()
      expect(s.get('a')?.enabled).toBe(true)
      expect(s.problems).toEqual([])
    })

    it('a directory at installed.json is a read error too, and is left alone', () => {
      mkdirSync(file(), { recursive: true })
      mkdirSync(join(code, 'a', 'b'.repeat(12)), { recursive: true })
      const s = open()
      expect(s.unreadable).toBe(true)
      expect(existsSync(join(code, 'a'))).toBe(true)
      expect(statSync(file()).isDirectory()).toBe(true)
    })

    it('a hand-deleted installed.json wipes nothing, even after a later install writes a new file', () => {
      plant()
      rmSync(file())
      const logs: string[] = []
      const log = { ...nullLogger, warn: (m: string, d?: unknown) => void logs.push(JSON.stringify([m, d])) }
      for (let boot = 0; boot < 2; boot++) {
        const s = PluginStore.open({ dataDir }, log)
        expect(s.problems).toEqual(['store_recovered'])
        expect(kept()).toBe(true)
      }
      expect(logs.join()).toContain('"count":2') // 代码和数据各一个
      expect(logs.join()).not.toMatch(/"a"|\/a\b/)
      const s = open()
      s.put(record('z'))
      s.save()
      expect(open().problems).toEqual(['store_recovered'])
      expect(kept()).toBe(true)
    })

    it('with neither a file nor plugin directories the store is fresh: bare .staging goes, no problem', () => {
      mkdirSync(join(code, '.staging', 'old'), { recursive: true })
      const s = open()
      expect(s.problems).toEqual([])
      expect(existsSync(code)).toBe(false)
      expect(readdirSync(dataDir)).toEqual([])
    })

    it('data with no code and no file counts as plugin directories', () => {
      mkdirSync(join(dataDir, 'plugin-data', 'a', 'srv'), { recursive: true })
      expect(open().problems).toEqual(['store_recovered'])
      expect(existsSync(join(dataDir, 'plugin-data', 'a', 'srv'))).toBe(true)
    })

    it('a recorded plugin is still reconciled during a keep boot: its stray version goes, an unknown id stays', () => {
      seed(record('a'))
      mkdirSync(join(code, 'ghost', 'b'.repeat(12)), { recursive: true })
      mkdirSync(join(code, 'a', 'c'.repeat(12)))
      writeFileSync(`${file()}.bad-1`, '{oops')
      open()
      expect(readdirSync(join(code, 'a'))).toEqual([hex.slice(0, 12)])
      expect(existsSync(join(code, 'ghost'))).toBe(true)
    })

    it('discard removes unknown directories and the bad files, keeps what is recorded, clears the problem', () => {
      seed(record('a'))
      mkdirSync(join(code, 'ghost', 'b'.repeat(12)), { recursive: true })
      mkdirSync(join(dataDir, 'plugin-data', 'ghost', 'srv'), { recursive: true })
      writeFileSync(`${file()}.bad-1`, '{oops')
      const s = open()
      s.discardUnknown()
      expect(s.problems).toEqual([])
      expect(readdirSync(code)).toEqual(['a'])
      expect(existsSync(join(dataDir, 'plugin-data', 'ghost'))).toBe(false)
      expect(readdirSync(join(dataDir, 'plugins', 'plugin-manager'))).toEqual(['installed.json'])
      expect(open().problems).toEqual([])
    })

    it('discard after a hand-deleted file does not re-detect what it just removed', () => {
      mkdirSync(join(code, 'ghost'), { recursive: true })
      const s = open()
      s.discardUnknown()
      expect(existsSync(code)).toBe(false)
      expect(open().problems).toEqual([])
    })

    it('badSecrets reads what a bad file lists, leniently, and skips a plugin installed since', () => {
      seed(record('live'))
      const bad = { version: 9, plugins: [{ id: 'old', secretKeys: ['K1', 'K2', 'b/ad'] }, { id: 'live', secretKeys: ['K'] }, { id: '../x', secretKeys: ['K'] }, 7] }
      writeFileSync(`${file()}.bad-1`, JSON.stringify(bad))
      writeFileSync(`${file()}.bad-2`, '{not json')
      expect(open().badSecrets()).toEqual([{ id: 'old', key: 'K1' }, { id: 'old', key: 'K2' }])
    })

    it('reconcile logs a count, never a name', () => {
      seed(record('a'))
      mkdirSync(join(code, 'secretname', 'b'.repeat(12)), { recursive: true })
      const logs: string[] = []
      PluginStore.open({ dataDir }, { ...nullLogger, info: (m, d) => void logs.push(JSON.stringify([m, d])), warn: (m, d) => void logs.push(JSON.stringify([m, d])) })
      expect(logs.join()).toContain('"removed":1')
      expect(logs.join()).not.toContain('secretname')
    })

    it('a crash during an in-place swap: the set-aside dir comes back', () => {
      seed(record('a'))
      const keep = hex.slice(0, 12)
      writeFileSync(join(code, 'a', keep, 'f'), 'x')
      renameSync(join(code, 'a', keep), join(code, 'a', `${keep}.old-1`))
      open()
      expect(readFileSync(join(code, 'a', keep, 'f'), 'utf8')).toBe('x')
      expect(readdirSync(join(code, 'a'))).toEqual([keep])
    })
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

    it('a directory planted at the store root before any install is inert: not a record, reported, removed by discard', () => {
      mkdirSync(join(code, 'evil', 'b'.repeat(12)), { recursive: true })
      writeFileSync(join(code, 'evil', 'b'.repeat(12), 'x'), 'planted')
      mkdirSync(join(code, '.staging', 'st'), { recursive: true })
      const s = open()
      expect(s.list()).toEqual([])
      expect(s.problems).toEqual(['store_recovered'])
      expect(existsSync(join(code, '.staging'))).toBe(false)
      s.discardUnknown()
      expect(existsSync(code)).toBe(false)
    })

    it('m2: a link at plugin-data/<id> of a recorded plugin is not kept, and its target is not touched', () => {
      seed(record('a'))
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      writeFileSync(join(elsewhere, 'f'), 'keep')
      mkdirSync(join(dataDir, 'plugin-data'), { recursive: true })
      symlinkSync(elsewhere, join(dataDir, 'plugin-data', 'a'))
      open()
      expect(existsSync(join(dataDir, 'plugin-data', 'a'))).toBe(false)
      expect(readFileSync(join(elsewhere, 'f'), 'utf8')).toBe('keep')
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

    it('notices a directory planted after open, before the first use: kept inert and reported', () => {
      const s = open()
      mkdirSync(join(code, 'evil', 'b'.repeat(12)), { recursive: true })
      s.ensure()
      expect(readdirSync(code).sort()).toEqual(['.staging', 'evil'])
      expect(s.problems).toEqual(['store_recovered'])
      expect(s.list()).toEqual([])
    })

    it('tidy removes the empty root and the next ensure treats a plant as foreign again', () => {
      const s = open()
      s.ensure()
      s.tidy()
      expect(existsSync(code)).toBe(false)
      mkdirSync(join(code, 'evil'), { recursive: true })
      s.ensure()
      expect(s.problems).toEqual(['store_recovered'])
    })

    it('ensureCodeDir with the root swapped for a link: the link goes, a real directory replaces it, the target is not written', () => {
      const s = open()
      const elsewhere = join(root, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, code)
      s.ensureCodeDir('a')
      expect(readdirSync(elsewhere)).toEqual([])
      expect(lstatSync(code).isDirectory()).toBe(true)
      expect(lstatSync(join(code, 'a')).isDirectory()).toBe(true)
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

  describe('I3: removal never recurses through a link', () => {
    const victim = () => {
      const v = join(root, 'victim')
      mkdirSync(join(v, 'a'), { recursive: true })
      writeFileSync(join(v, 'a', 'canary'), 'alive')
      return v
    }
    it('removeFiles with the store root swapped for a link: the link goes, the target stays', () => {
      seed(record('a'))
      const s = open()
      rmSync(code, { recursive: true })
      symlinkSync(victim(), code)
      s.removeFiles('a')
      expect(readFileSync(join(root, 'victim', 'a', 'canary'), 'utf8')).toBe('alive')
      expect(existsSync(code)).toBe(false)
    })
    it('removeFiles with plugin-data swapped for a link, and with <id> a link', () => {
      seed(record('a'))
      const s = open()
      symlinkSync(victim(), join(dataDir, 'plugin-data'))
      rmSync(join(code, 'a'), { recursive: true })
      symlinkSync(join(root, 'victim'), join(code, 'a'))
      s.removeFiles('a')
      expect(readFileSync(join(root, 'victim', 'a', 'canary'), 'utf8')).toBe('alive')
      expect(existsSync(join(code, 'a'))).toBe(false)
      expect(existsSync(join(dataDir, 'plugin-data'))).toBe(false)
    })
    it('removeFiles removes the real thing', () => {
      seed(record('a'), record('b'))
      mkdirSync(join(dataDir, 'plugin-data', 'a', 'srv'), { recursive: true })
      const s = open()
      s.removeFiles('a')
      expect(readdirSync(code)).toEqual(['b'])
      expect(existsSync(join(dataDir, 'plugin-data', 'a'))).toBe(false)
    })
    it('a read-only directory inside is no obstacle; a removal that really fails answers false and does not throw', () => {
      seed(record('a'))
      const dir = join(code, 'a', hex.slice(0, 12), 'locked')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      chmodSync(dir, 0o555)
      const s = open()
      expect(s.removeVersion(record('a'))).toBe(true)
      mkdirSync(join(code, 'a', hex.slice(0, 12)), { recursive: true })
      chmodSync(code, 0o555)
      try {
        expect(s.removeFiles('a')).toBe(false)
      } finally {
        chmodSync(code, 0o755)
      }
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
    it('m1: any .git entry is a mismatch, at any depth, whatever its case, though the walk skips it', () => {
      const s = open()
      const { dir, rec } = build(s)
      for (const rel of ['.git', 'sub/.GIT']) {
        mkdirSync(join(dir, rel), { recursive: true })
        expect(s.verify(rec), rel).toBe(false)
        rmSync(join(dir, rel.split('/')[0]), { recursive: true })
      }
      writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere')
      expect(s.verify(rec)).toBe(false)
      rmSync(join(dir, '.git'))
      expect(s.verify(rec)).toBe(true)
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
