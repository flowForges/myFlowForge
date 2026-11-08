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

describe('dirSize', async () => {
  it('sums file sizes in nested directories', async () => {
    const d = join(root, 'd')
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    writeFileSync(join(d, 'x'), Buffer.alloc(100))
    writeFileSync(join(d, 'a', 'y'), Buffer.alloc(250))
    writeFileSync(join(d, 'a', 'b', 'z'), Buffer.alloc(7))
    expect(await dirSize(d)).toBe(357)
  })

  it('a symlink to a big directory is not followed', async () => {
    const big = join(root, 'big')
    mkdirSync(big)
    writeFileSync(join(big, 'huge'), Buffer.alloc(1 << 20))
    const d = join(root, 'd')
    mkdirSync(d)
    writeFileSync(join(d, 'small'), Buffer.alloc(10))
    symlinkSync(big, join(d, 'link'))
    symlinkSync(join(big, 'huge'), join(d, 'filelink'))
    const n = (await dirSize(d))!
    expect(n).toBeGreaterThanOrEqual(10)
    expect(n).toBeLessThan(1 << 16)
  })

  it('past the entry cap: undefined', async () => {
    const d = join(root, 'd')
    mkdirSync(d)
    for (let i = 0; i < 30; i++) writeFileSync(join(d, `f${i}`), 'x')
    expect(await dirSize(d, { maxEntries: 20 })).toBeUndefined()
    expect(await dirSize(d, { maxEntries: 50 })).toBe(30)
  })

  it('a root that is missing, a file or a symlink: undefined', async () => {
    expect(await dirSize(join(root, 'nope'))).toBeUndefined()
    writeFileSync(join(root, 'f'), 'x')
    expect(await dirSize(join(root, 'f'))).toBeUndefined()
    mkdirSync(join(root, 'real'))
    symlinkSync(join(root, 'real'), join(root, 'ln'))
    expect(await dirSize(join(root, 'ln'))).toBeUndefined()
  })

  it('yields while it walks: a ping set before it runs fires before it ends (review I4)', async () => {
    const d = join(root, 'd')
    mkdirSync(d)
    for (let i = 0; i < 3000; i++) writeFileSync(join(d, `f${i}`), 'x')
    const order: string[] = []
    setImmediate(() => order.push('ping'))
    await dirSize(d, { yieldEvery: 100 }).then(() => order.push('done'))
    expect(order).toEqual(['ping', 'done'])
  })

  it('cached by path and the root mtime: a deep change is not seen until the root changes', async () => {
    const d = join(root, 'd')
    mkdirSync(join(d, 'deep'), { recursive: true })
    writeFileSync(join(d, 'deep', 'a'), Buffer.alloc(10))
    const t = new Date(2020, 0, 1)
    const { utimesSync } = await import('node:fs')
    utimesSync(d, t, t)
    expect(await dirSize(d)).toBe(10)
    writeFileSync(join(d, 'deep', 'b'), Buffer.alloc(5))
    expect(await dirSize(d)).toBe(10)
    writeFileSync(join(d, 'top'), Buffer.alloc(1))
    expect(await dirSize(d)).toBe(16)
  })
})
