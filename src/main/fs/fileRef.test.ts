import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveFileRef, isInside } from './fileRef'

// 真目录,不是假 fs —— 越界/存在性这类判断在假 fs 上验不出真行为。
let root = ''
let projA = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fileref-'))
  projA = join(root, 'projA')
  mkdirSync(join(projA, 'docs'), { recursive: true })
  writeFileSync(join(projA, 'docs', 'design.md'), '# hi')
  writeFileSync(join(root, 'top.md'), '# top')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('resolveFileRef', () => {
  it('相对路径命中第一个 base', () => {
    const r = resolveFileRef([projA, root], 'docs/design.md')
    expect(r).toMatchObject({ ok: true, cwd: projA, file: join('docs', 'design.md') })
  })
  it('第一个 base 没有时回退到下一个', () => {
    const r = resolveFileRef([projA, root], 'top.md')
    expect(r).toMatchObject({ ok: true, cwd: root, file: 'top.md' })
  })
  it('绝对路径落在 base 内 → 返回相对该 base 的路径', () => {
    const r = resolveFileRef([root], join(projA, 'docs', 'design.md'))
    expect(r).toMatchObject({ ok: true, cwd: root, file: join('projA', 'docs', 'design.md') })
  })
  it('file:// 协议同样能解析', () => {
    const r = resolveFileRef([root], `file://${join(projA, 'docs', 'design.md')}`)
    expect(r.ok).toBe(true)
  })
  it('锚点不影响解析', () => {
    expect(resolveFileRef([projA], 'docs/design.md#标题').ok).toBe(true)
  })
  it('不存在 → missing', () => {
    expect(resolveFileRef([projA], 'docs/nope.md')).toEqual({ ok: false, reason: 'missing' })
  })
  it('是目录 → dir', () => {
    expect(resolveFileRef([projA], 'docs')).toEqual({ ok: false, reason: 'dir' })
  })
  it('越界 → outside(即使目标真实存在)', () => {
    expect(resolveFileRef([projA], '../top.md')).toEqual({ ok: false, reason: 'outside' })
    expect(resolveFileRef([projA], '/etc/hosts')).toEqual({ ok: false, reason: 'outside' })
  })
  it('空 href / 空 bases → bad', () => {
    expect(resolveFileRef([projA], '   ')).toEqual({ ok: false, reason: 'bad' })
    expect(resolveFileRef([], 'a.md')).toEqual({ ok: false, reason: 'bad' })
  })
})

describe('isInside', () => {
  it('同名前缀目录不算在内', () => {
    expect(isInside('/a/b', '/a/bc/d')).toBe(false)
    expect(isInside('/a/b', '/a/b/d')).toBe(true)
    expect(isInside('/a/b', '/a/b')).toBe(true)
  })
})
