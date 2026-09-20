import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, parse, sep } from 'node:path'
import { listDir, parentOf, defaultRoots } from './browse'

let root = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'browse-'))
  mkdirSync(join(root, 'beta'))
  mkdirSync(join(root, 'alpha'))
  mkdirSync(join(root, '.hidden'))
  mkdirSync(join(root, 'ws', '.forge'), { recursive: true })
  writeFileSync(join(root, 'ws', '.forge', 'workspace.json'), '{}')
  writeFileSync(join(root, 'note.txt'), 'x')
})
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('listDir', () => {
  it('默认只列目录,目录在前按名字排', () => {
    const r = listDir(root)
    expect(r.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'ws'])
    expect(r.entries.every((e) => e.dir)).toBe(true)
  })

  it('filesToo 时把文件也列出来,但目录仍排在前面', () => {
    const r = listDir(root, { filesToo: true })
    expect(r.entries.map((e) => e.name)).toEqual(['alpha', 'beta', 'ws', 'note.txt'])
  })

  it('默认藏起点开头的条目,showHidden 时露出来', () => {
    expect(listDir(root).entries.some((e) => e.name === '.hidden')).toBe(false)
    expect(listDir(root, { showHidden: true }).entries.some((e) => e.name === '.hidden')).toBe(true)
  })

  it('认得出哪个目录已经是工作区(选目录时能提示)', () => {
    expect(listDir(join(root, 'ws')).isWorkspace).toBe(true)
    expect(listDir(root).isWorkspace).toBe(false)
  })

  it('★目录不存在只回一句话,不抛 —— 远程那头抛出去就变成红字报错', () => {
    const r = listDir(join(root, 'nope'))
    expect(r.error).toBeTruthy()
    expect(r.entries).toEqual([])
  })

  it('★没权限的目录同样只回一句话', () => {
    // /root 在 macOS/Linux 上普通用户都读不了;读得了(比如 CI 里是 root)就跳过这条。
    const r = listDir(sep === '\\' ? 'C:\\System Volume Information' : '/root')
    if (!r.error) return
    expect(r.entries).toEqual([])
    expect(typeof r.error).toBe('string')
  })

  it('★单个条目坏掉(断掉的软链)只跳过它,不能让整个目录列不出来', () => {
    const d = join(root, 'withbad')
    mkdirSync(d)
    mkdirSync(join(d, 'good'))
    try { symlinkSync(join(root, '不存在的目标'), join(d, 'broken')) } catch { return }
    const r = listDir(d)
    expect(r.entries.map((e) => e.name)).toEqual(['good'])
    expect(r.error).toBeUndefined()
  })

  it('空路径回落到家目录 —— 界面第一次打开时不用先知道从哪儿开始', () => {
    expect(listDir('').path).toBe(homedir())
  })
})

describe('parentOf', () => {
  it('普通目录给出上一层', () => {
    expect(parentOf(join(root, 'alpha'))).toBe(root)
  })
  it('★根目录没有上一层 —— dirname("/") 还是 "/",直接用会做出一个点不动的「返回」', () => {
    expect(parentOf(sep === '\\' ? parse(homedir()).root : '/')).toBeNull()
  })
})

describe('defaultRoots', () => {
  it('至少给出主目录,且列出来的都真实存在', () => {
    const roots = defaultRoots()
    expect(roots.some((r) => r.path === homedir())).toBe(true)
    // 列一个点进去就报错的入口是纯添乱。
    for (const r of roots) expect(listDir(r.path).error).toBeUndefined()
  })
})
