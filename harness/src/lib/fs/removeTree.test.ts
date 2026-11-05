// 敌意树的删除(09 Task 9 I3):服务能把自己的数据目录锁住,不能因此留下东西。只动树里的东西,不穿过链接
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTree } from './removeTree'

const darwin = process.platform === 'darwin'
const flagged = (p: string) => execFileSync('/bin/ls', ['-ldO', p], { encoding: 'utf8' })
const noFlags = (p: string) => {
  try {
    execFileSync('/usr/bin/chflags', ['-R', 'nouchg,nouappnd', p], { stdio: 'ignore' })
  } catch {
    /* 已经没了 */
  }
}

let tmp: string
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mffai-rm-')))
})
afterEach(() => {
  if (darwin) noFlags(tmp)
  execFileSync('/bin/chmod', ['-R', 'u+rwx', tmp])
  rmSync(tmp, { recursive: true, force: true })
})

describe('removeTree', () => {
  it('a plain tree; a path that is not there is already gone', () => {
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true })
    writeFileSync(join(tmp, 'a', 'b', 'f'), 'x')
    expect(removeTree(join(tmp, 'a'))).toBe(true)
    expect(existsSync(join(tmp, 'a'))).toBe(false)
    expect(removeTree(join(tmp, 'never'))).toBe(true)
  })

  it('directories with mode 000, at any depth, the top included', () => {
    const top = join(tmp, 'top')
    mkdirSync(join(top, 'k', 'deep'), { recursive: true })
    writeFileSync(join(top, 'k', 'deep', 'f'), 'x')
    chmodSync(join(top, 'k', 'deep'), 0)
    chmodSync(join(top, 'k'), 0)
    chmodSync(top, 0o500)
    expect(removeTree(top)).toBe(true)
    expect(existsSync(top)).toBe(false)
  })

  it.skipIf(!darwin)('files and directories with uchg or uappnd, under a 000 directory too', () => {
    const top = join(tmp, 'top')
    mkdirSync(join(top, 'k', 'in'), { recursive: true })
    writeFileSync(join(top, 'k', 'f'), 'x')
    writeFileSync(join(top, 'k', 'in', 'g'), 'x')
    execFileSync('/usr/bin/chflags', ['uchg', join(top, 'k', 'f')])
    execFileSync('/usr/bin/chflags', ['uappnd', join(top, 'k', 'in', 'g')])
    chmodSync(join(top, 'k', 'in'), 0)
    execFileSync('/usr/bin/chflags', ['uchg', join(top, 'k')])
    expect(removeTree(top)).toBe(true)
    expect(existsSync(top)).toBe(false)
  })

  it('a link in the tree: the target keeps its mode, flags and contents', () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    chmodSync(outside, 0o555)
    if (darwin) execFileSync('/usr/bin/chflags', ['uchg', join(outside, 'keep')])
    const top = join(tmp, 'top')
    mkdirSync(join(top, 'locked'), { recursive: true })
    symlinkSync(outside, join(top, 'locked', 'dir-link'))
    symlinkSync(join(outside, 'keep'), join(top, 'locked', 'file-link'))
    chmodSync(join(top, 'locked'), 0)
    const before = flagged(outside) + flagged(join(outside, 'keep'))
    expect(removeTree(top)).toBe(true)
    expect(flagged(outside) + flagged(join(outside, 'keep'))).toBe(before)
    expect(statSync(outside).mode & 0o777).toBe(0o555)
    expect(readdirSync(outside)).toEqual(['keep'])
  })

  it('the top being a link: only the link goes', () => {
    const outside = join(tmp, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    symlinkSync(outside, join(tmp, 'top'))
    expect(removeTree(join(tmp, 'top'))).toBe(true)
    expect(() => lstatSync(join(tmp, 'top'))).toThrow()
    expect(readdirSync(outside)).toEqual(['keep'])
  })

  it('a parent it may not change: false, nothing thrown', () => {
    const parent = join(tmp, 'parent')
    mkdirSync(join(parent, 'top'), { recursive: true })
    chmodSync(parent, 0o555)
    expect(removeTree(join(parent, 'top'))).toBe(false)
    expect(existsSync(join(parent, 'top'))).toBe(true)
  })

  it('a very deep tree does not blow the stack', () => {
    let p = join(tmp, 'top')
    mkdirSync(p)
    const top = p
    for (let i = 0; i < 200; i++) {
      p = join(p, 'd')
      mkdirSync(p)
    }
    chmodSync(top, 0o500)
    expect(removeTree(top)).toBe(true)
  })
})
