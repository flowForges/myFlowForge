import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_DEV_MAIN_BYTES, readDevIndex, removeDevPlugin, trustDevPlugin } from './devStore'

const SRC = 'export default { manifest: { id: "dev-x", version: "1.0.0", kernel: "^0.1.0" }, activate() {} }\n'
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const NOW = 1_700_000_000_000

let tmp = ''
let dataDir = ''
let src = ''
const reservedIds = new Set(['memory-default', 'dev-reserved'])
const manifest = (over: Record<string, unknown> = {}) => JSON.stringify({ id: 'dev-x', version: '1.0.0', main: 'dist/plugin.mjs', ...over })

function build(o: { manifest?: string; main?: string | null; at?: string } = {}): string {
  const dir = join(src, o.at ?? 'plugin')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'mff-plugin.json'), o.manifest ?? manifest())
  if (o.main !== null) writeFileSync(join(dir, 'dist', 'plugin.mjs'), o.main ?? SRC)
  return dir
}
const trust = (path: string, over: Partial<Parameters<typeof trustDevPlugin>[0]> = {}) => trustDevPlugin({ dataDir, path, reservedIds, now: () => NOW, ...over })
const devDir = () => join(dataDir, 'dev-plugins')
/** 失败的确认什么都不留 */
const nothingLanded = () => expect(existsSync(devDir()) ? readdirSync(devDir()) : []).toEqual([])
const failsWith = (r: ReturnType<typeof trustDevPlugin>, error: string) => {
  expect(r).toEqual({ ok: false, error })
  nothingLanded()
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-devstore-')))
  dataDir = join(tmp, 'data')
  src = join(tmp, 'src')
  mkdirSync(dataDir)
  mkdirSync(src)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('trustDevPlugin', () => {
  it('copies the bytes it read, says what it trusted, and records it', () => {
    const r = trust(build())
    const hash = sha(SRC)
    expect(r).toEqual({ ok: true, id: 'dev-x', hash, bytes: Buffer.byteLength(SRC), main: 'dist/plugin.mjs' })
    const file = join(devDir(), 'dev-x', `entry-${hash.slice(0, 12)}.mjs`)
    expect(readFileSync(file, 'utf8')).toBe(SRC)
    expect(readDevIndex(dataDir)).toEqual([{ id: 'dev-x', hash, file, trustedAt: NOW }])
    expect(readdirSync(join(devDir(), 'dev-x'))).toEqual([`entry-${hash.slice(0, 12)}.mjs`])
    expect(readdirSync(devDir()).sort()).toEqual(['dev-x', 'index.json'])
  })

  it('the copy and the record are 0600, their directories 0700', () => {
    const r = trust(build())
    if (!r.ok) throw new Error(r.error)
    const mode = (p: string) => statSync(p).mode & 0o777
    expect(mode(readDevIndex(dataDir)[0].file)).toBe(0o600)
    expect(mode(join(devDir(), 'index.json'))).toBe(0o600)
    expect(mode(devDir())).toBe(0o700)
    expect(mode(join(devDir(), 'dev-x'))).toBe(0o700)
  })

  it('reads once: a write to the source after the read reaches neither the hash nor the copy', () => {
    const dir = build()
    const r = trust(dir, { onStep: s => { if (s === 'read') writeFileSync(join(dir, 'dist', 'plugin.mjs'), 'export default "swapped"') } })
    expect(r).toMatchObject({ ok: true, hash: sha(SRC), bytes: Buffer.byteLength(SRC) })
    expect(readFileSync(readDevIndex(dataDir)[0].file, 'utf8')).toBe(SRC)
  })

  it('O_NOFOLLOW: main swapped for a link between the lstat and the open is refused', () => {
    const dir = build()
    const outside = join(tmp, 'outside.mjs')
    writeFileSync(outside, 'export default "outside"')
    const main = join(dir, 'dist', 'plugin.mjs')
    const r = trust(dir, { onStep: s => { if (s === 'checked') { rmSync(main); symlinkSync(outside, main) } } })
    failsWith(r, 'symlink')
  })

  it('a FIFO swapped in between the lstat and the open neither hangs nor is read', () => {
    const dir = build()
    const main = join(dir, 'dist', 'plugin.mjs')
    const r = trust(dir, { onStep: s => { if (s === 'checked') { rmSync(main); execFileSync('mkfifo', [main]) } } })
    failsWith(r, 'main_invalid')
  })

  it('a file growing past the cap after the fstat is refused: the read itself is bounded', () => {
    const dir = build()
    const main = join(dir, 'dist', 'plugin.mjs')
    const r = trust(dir, { onStep: s => { if (s === 'opened') truncateSync(main, MAX_DEV_MAIN_BYTES + 1) } })
    failsWith(r, 'too_large')
  })

  it.each([
    ['not there', () => join(src, 'nope'), 'not_found'],
    ['a file, not a directory', () => { const f = join(src, 'f'); writeFileSync(f, ''); return f }, 'not_found'],
    ['no manifest', () => { const d = join(src, 'empty'); mkdirSync(d); return d }, 'not_found'],
    ['manifest not JSON', () => build({ manifest: '{' }), 'bad_manifest'],
    ['manifest with an unknown key', () => build({ manifest: manifest({ extra: 1 }) }), 'bad_manifest'],
    ['manifest over the cap', () => build({ manifest: `{"id":"dev-x","description":"${'x'.repeat(2 * 1024 * 1024)}"}` }), 'bad_manifest'],
    ['planted id without dev-', () => build({ manifest: manifest({ id: 'memory-default' }) }), 'id_not_dev'],
    ['plain id', () => build({ manifest: manifest({ id: 'x' }) }), 'id_not_dev'],
    ['bare dev- id', () => build({ manifest: manifest({ id: 'dev-' }) }), 'id_not_dev'],
    ['id with the prefix inside', () => build({ manifest: manifest({ id: 'x-dev-y' }) }), 'id_not_dev'],
    ['reserved id', () => build({ manifest: manifest({ id: 'dev-reserved' }) }), 'id_not_dev'],
    ['no main', () => build({ manifest: JSON.stringify({ id: 'dev-x', version: '1.0.0' }) }), 'main_invalid'],
    ['main outside the directory', () => { writeFileSync(join(src, 'out.mjs'), SRC); return build({ manifest: manifest({ main: '../out.mjs' }) }) }, 'main_invalid'],
    ['main with .. inside', () => build({ manifest: manifest({ main: 'dist/../dist/plugin.mjs' }) }), 'main_invalid'],
    ['absolute main', () => build({ manifest: manifest({ main: join(src, 'out.mjs') }) }), 'main_invalid'],
    ['main with a backslash', () => build({ manifest: manifest({ main: 'dist\\plugin.mjs' }) }), 'main_invalid'],
    ['main with a control character', () => build({ manifest: manifest({ main: 'dist/plu\ngin.mjs' }) }), 'main_invalid'],
    ['main not .mjs', () => { const d = build(); writeFileSync(join(d, 'dist', 'plugin.js'), SRC); writeFileSync(join(d, 'mff-plugin.json'), manifest({ main: 'dist/plugin.js' })); return d }, 'main_invalid'],
    ['main missing', () => build({ main: null }), 'main_invalid'],
    ['main is a directory', () => { const d = build(); mkdirSync(join(d, 'dist', 'dir.mjs')); writeFileSync(join(d, 'mff-plugin.json'), manifest({ main: 'dist/dir.mjs' })); return d }, 'main_invalid'],
  ] as [string, () => string, string][])('%s → %s', (_, make, error) => {
    failsWith(trust(make()), error)
  })

  it('symlinks: main, a directory on the way to it, the manifest. Nothing is read through them', () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'plugin.mjs'), 'export default "outside"')
    writeFileSync(join(outside, 'mff-plugin.json'), manifest())

    const a = build({ at: 'a', main: null })
    symlinkSync(join(outside, 'plugin.mjs'), join(a, 'dist', 'plugin.mjs'))
    failsWith(trust(a), 'symlink')

    const inside = build({ at: 'inside' })
    rmSync(join(inside, 'dist', 'plugin.mjs'))
    writeFileSync(join(inside, 'real.mjs'), SRC)
    symlinkSync(join(inside, 'real.mjs'), join(inside, 'dist', 'plugin.mjs'))
    failsWith(trust(inside), 'symlink') // 目标在目录里面也不行

    const b = build({ at: 'b', main: null })
    rmSync(join(b, 'dist'), { recursive: true })
    symlinkSync(outside, join(b, 'dist'))
    failsWith(trust(b), 'symlink')

    const c = join(src, 'c')
    mkdirSync(c)
    symlinkSync(join(outside, 'mff-plugin.json'), join(c, 'mff-plugin.json'))
    failsWith(trust(c), 'symlink')
  })

  it('FIFOs do not hang it', () => {
    const a = build({ main: null, at: 'a' })
    execFileSync('mkfifo', [join(a, 'dist', 'plugin.mjs')])
    failsWith(trust(a), 'main_invalid')
    const b = join(src, 'b')
    mkdirSync(b)
    execFileSync('mkfifo', [join(b, 'mff-plugin.json')])
    failsWith(trust(b), 'bad_manifest')
  })

  it('the size cap: exactly 20 MB passes, one more byte does not', () => {
    const dir = build()
    const main = join(dir, 'dist', 'plugin.mjs')
    truncateSync(main, MAX_DEV_MAIN_BYTES)
    expect(MAX_DEV_MAIN_BYTES).toBe(20 * 1024 * 1024)
    expect(trust(dir)).toMatchObject({ ok: true, bytes: MAX_DEV_MAIN_BYTES })
    rmSync(devDir(), { recursive: true })
    truncateSync(main, MAX_DEV_MAIN_BYTES + 1)
    failsWith(trust(dir), 'too_large')
  })

  it('refusePath sees the directory that holds main, so a good root cannot reach a bad folder', () => {
    const dir = build()
    const seen: string[] = []
    failsWith(trust(dir, { refusePath: d => (seen.push(d), true) }), 'main_invalid')
    expect(seen).toEqual([join(dir, 'dist')])
  })

  it('a new trust replaces the old copy; a failed one leaves everything as it was', () => {
    const dir = build()
    const first = trust(dir)
    if (!first.ok) throw new Error(first.error)
    const main = join(dir, 'dist', 'plugin.mjs')
    const v2 = `${SRC}// v2\n`

    // 改源文件不动副本
    writeFileSync(main, v2)
    expect(readFileSync(readDevIndex(dataDir)[0].file, 'utf8')).toBe(SRC)

    // 失败的确认不动旧的
    const before = readDevIndex(dataDir)
    rmSync(main)
    symlinkSync(join(tmp, 'x'), main)
    expect(trust(dir)).toEqual({ ok: false, error: 'symlink' })
    expect(readDevIndex(dataDir)).toEqual(before)
    expect(readFileSync(before[0].file, 'utf8')).toBe(SRC)

    rmSync(main)
    writeFileSync(main, v2)
    const second = trust(dir, { now: () => NOW + 1 })
    expect(second).toMatchObject({ ok: true, hash: sha(v2) })
    expect(readDevIndex(dataDir)).toEqual([{ id: 'dev-x', hash: sha(v2), file: join(devDir(), 'dev-x', `entry-${sha(v2).slice(0, 12)}.mjs`), trustedAt: NOW + 1 }])
    expect(readdirSync(join(devDir(), 'dev-x'))).toEqual([`entry-${sha(v2).slice(0, 12)}.mjs`])
  })

  it('trusting the same bytes again keeps one copy and moves trustedAt', () => {
    const dir = build()
    trust(dir)
    expect(trust(dir, { now: () => NOW + 5 })).toMatchObject({ ok: true })
    expect(readDevIndex(dataDir).map(e => e.trustedAt)).toEqual([NOW + 5])
    expect(readdirSync(join(devDir(), 'dev-x'))).toHaveLength(1)
  })

  it('two plugins sit side by side, sorted', () => {
    trust(build({ at: 'b', manifest: manifest({ id: 'dev-b' }) }))
    trust(build({ at: 'a', manifest: manifest({ id: 'dev-a' }) }))
    expect(readDevIndex(dataDir).map(e => e.id)).toEqual(['dev-a', 'dev-b'])
  })

  it('a link planted as dev-plugins or as the id directory: nothing lands through it', () => {
    const outside = join(tmp, 'elsewhere')
    mkdirSync(outside)
    symlinkSync(outside, devDir())
    expect(trust(build())).toEqual({ ok: false, error: 'store_error' })
    expect(readdirSync(outside)).toEqual([])
    rmSync(devDir())
    mkdirSync(devDir())
    symlinkSync(outside, join(devDir(), 'dev-x'))
    expect(trust(build())).toEqual({ ok: false, error: 'store_error' })
    expect(readdirSync(outside)).toEqual([])
  })

  it('a write failure is store_error, leaves no temp file, and leaves the old record', () => {
    const dir = build()
    trust(dir)
    const before = readDevIndex(dataDir)
    writeFileSync(join(dir, 'dist', 'plugin.mjs'), `${SRC}// v2\n`)
    chmodSync(join(devDir(), 'dev-x'), 0o500)
    expect(trust(dir)).toEqual({ ok: false, error: 'store_error' })
    chmodSync(join(devDir(), 'dev-x'), 0o700)
    expect(readDevIndex(dataDir)).toEqual(before)
    expect(readdirSync(join(devDir(), 'dev-x'))).toEqual([before[0].file.split('/').pop()])
  })
})

describe('readDevIndex', () => {
  it('nothing trusted: an empty list, and nothing is created', () => {
    expect(readDevIndex(dataDir)).toEqual([])
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('a corrupt record loads nothing, and says so', () => {
    mkdirSync(devDir())
    writeFileSync(join(devDir(), 'index.json'), '{')
    const warned: string[] = []
    expect(readDevIndex(dataDir, { warn: m => warned.push(m) })).toEqual([])
    expect(warned).toHaveLength(1)
  })

  it.each([
    ['an id without dev-', { id: 'memory-default', hash: 'a'.repeat(64), trustedAt: 1 }],
    ['an id that climbs', { id: 'dev-../../x', hash: 'a'.repeat(64), trustedAt: 1 }],
    ['a short hash', { id: 'dev-x', hash: 'abc', trustedAt: 1 }],
    ['a hash that climbs', { id: 'dev-x', hash: `../../${'a'.repeat(58)}`, trustedAt: 1 }],
    ['no trustedAt', { id: 'dev-x', hash: 'a'.repeat(64) }],
    ['not an object', 'dev-x'],
  ])('a planted entry with %s is dropped', (_, entry) => {
    mkdirSync(devDir())
    const good = { id: 'dev-ok', hash: 'b'.repeat(64), trustedAt: 2 }
    writeFileSync(join(devDir(), 'index.json'), JSON.stringify({ entries: [entry, good] }))
    expect(readDevIndex(dataDir).map(e => e.id)).toEqual(['dev-ok'])
  })

  it('file is computed, never read from the record: a planted path goes nowhere', () => {
    mkdirSync(devDir())
    const hash = 'b'.repeat(64)
    writeFileSync(join(devDir(), 'index.json'), JSON.stringify({ entries: [{ id: 'dev-ok', hash, trustedAt: 2, file: '/tmp/evil.mjs' }] }))
    expect(readDevIndex(dataDir)[0].file).toBe(join(devDir(), 'dev-ok', `entry-${hash.slice(0, 12)}.mjs`))
  })
})

describe('removeDevPlugin', () => {
  it('takes the record and the copy, and only that plugin', () => {
    trust(build({ at: 'a', manifest: manifest({ id: 'dev-a' }) }))
    trust(build({ at: 'b', manifest: manifest({ id: 'dev-b' }) }))
    const keep = readDevIndex(dataDir).find(e => e.id === 'dev-b')!
    expect(removeDevPlugin({ dataDir, id: 'dev-a' })).toBe(true)
    expect(readDevIndex(dataDir)).toEqual([keep])
    expect(existsSync(join(devDir(), 'dev-a'))).toBe(false)
    expect(existsSync(keep.file)).toBe(true)
  })

  it('an id not on the list touches nothing, a climbing one least of all', () => {
    const victim = join(dataDir, 'victim')
    writeFileSync(victim, 'keep')
    trust(build())
    const before = readDevIndex(dataDir)
    removeDevPlugin({ dataDir, id: 'dev-nope' })
    removeDevPlugin({ dataDir, id: '../victim' })
    removeDevPlugin({ dataDir, id: 'dev-../../victim' })
    expect(readFileSync(victim, 'utf8')).toBe('keep')
    expect(readDevIndex(dataDir)).toEqual(before)
  })

  it('a link planted as the id directory is unlinked, not followed', () => {
    const outside = join(tmp, 'elsewhere')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'keep')
    trust(build())
    rmSync(join(devDir(), 'dev-x'), { recursive: true })
    symlinkSync(outside, join(devDir(), 'dev-x'))
    removeDevPlugin({ dataDir, id: 'dev-x' })
    expect(lstatSync(outside).isDirectory()).toBe(true)
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep')
    expect(existsSync(join(devDir(), 'dev-x'))).toBe(false)
  })

  it('removing the last leaves no files in the way of an idle start', () => {
    trust(build())
    removeDevPlugin({ dataDir, id: 'dev-x' })
    expect(readDevIndex(dataDir)).toEqual([])
    expect(readdirSync(devDir())).toEqual(['index.json'])
    expect(dirname(devDir())).toBe(dataDir)
  })
})
