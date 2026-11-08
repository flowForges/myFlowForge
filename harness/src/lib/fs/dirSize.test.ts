// 08 §4.4:worktree 占多大。lstat,不跟链接;项数超上限不给
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dirSize } from './dirSize'

let root: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-dirsize-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('dirSize', () => {
  it('sums file sizes in nested directories', () => {
    const d = join(root, 'd')
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    writeFileSync(join(d, 'x'), Buffer.alloc(100))
    writeFileSync(join(d, 'a', 'y'), Buffer.alloc(250))
    writeFileSync(join(d, 'a', 'b', 'z'), Buffer.alloc(7))
    expect(dirSize(d)).toBe(357)
  })

  it('a symlink to a big directory is not followed', () => {
    const big = join(root, 'big')
    mkdirSync(big)
    writeFileSync(join(big, 'huge'), Buffer.alloc(1 << 20))
    const d = join(root, 'd')
    mkdirSync(d)
    writeFileSync(join(d, 'small'), Buffer.alloc(10))
    symlinkSync(big, join(d, 'link'))
    symlinkSync(join(big, 'huge'), join(d, 'filelink'))
    const n = dirSize(d)!
    expect(n).toBeGreaterThanOrEqual(10)
    expect(n).toBeLessThan(1 << 16)
  })

  it('past the entry cap: undefined', () => {
    const d = join(root, 'd')
    mkdirSync(d)
    for (let i = 0; i < 30; i++) writeFileSync(join(d, `f${i}`), 'x')
    expect(dirSize(d, { maxEntries: 20 })).toBeUndefined()
    expect(dirSize(d, { maxEntries: 50 })).toBe(30)
  })

  it('a root that is missing, a file or a symlink: undefined', () => {
    expect(dirSize(join(root, 'nope'))).toBeUndefined()
    writeFileSync(join(root, 'f'), 'x')
    expect(dirSize(join(root, 'f'))).toBeUndefined()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'ln'))
    expect(dirSize(join(root, 'ln'))).toBeUndefined()
  })
})
