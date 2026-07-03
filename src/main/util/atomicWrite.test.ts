import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeJsonAtomic, writeTextAtomic } from './atomicWrite'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('writeJsonAtomic', () => {
  it('writes JSON to the target and leaves no .tmp behind', () => {
    const file = join(dir, 'data.json')
    writeJsonAtomic(file, { a: 1, b: '二' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 1, b: '二' })
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('preserves existing file content when the rename fails mid-write (crash-safety)', () => {
    const file = join(dir, 'data.json')
    writeFileSync(file, JSON.stringify({ old: true }), 'utf8')   // pre-existing good content
    // Simulate a crash after the temp write but before the rename completes.
    const throwingFs = {
      writeFileSync,
      renameSync: () => { throw new Error('simulated crash before rename completes') },
    }
    expect(() => writeJsonAtomic(file, { replaced: true }, throwingFs)).toThrow()
    // The original file must be untouched — never a partial/empty/corrupt target.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ old: true })
  })
})

describe('writeTextAtomic', () => {
  it('writes raw text via tmp+rename (no JSON encoding)', () => {
    const calls: string[] = []
    const fs = {
      writeFileSync: (f: string, d: string) => { calls.push(`w:${f}:${d}`) },
      renameSync: (a: string, b: string) => { calls.push(`r:${a}->${b}`) },
    }
    writeTextAtomic('/x/SKILL.md', 'hello\nworld', fs)
    expect(calls).toEqual(['w:/x/SKILL.md.tmp:hello\nworld', 'r:/x/SKILL.md.tmp->/x/SKILL.md'])
  })

  it('leaves the target untouched if rename throws (crash safety)', () => {
    const fs = {
      writeFileSync: () => {},
      renameSync: () => { throw new Error('boom') },
    }
    expect(() => writeTextAtomic('/x/SKILL.md', 'data', fs)).toThrow('boom')
  })
})
