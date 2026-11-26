import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImageRef, imageOptsFor } from './imageRef'

// 真目录真文件 —— 越界/存在性/体积这几条在假 fs 上验不出真行为(同 fileRef.test.ts)。
let root = '', ws = '', outside = ''
// 1×1 透明 png
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'imgref-'))
  ws = join(root, 'ws')
  outside = join(root, 'outside')
  mkdirSync(join(ws, 'out'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(ws, 'out', 'chart.png'), PNG)
  writeFileSync(join(ws, 'notes.md'), '# hi')
  writeFileSync(join(outside, 'secret.png'), PNG)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('readImageRef', () => {
  it('相对路径 → data URL', () => {
    const r = readImageRef([ws], 'out/chart.png')
    expect(r).toHaveProperty('dataUrl')
    expect((r as { dataUrl: string }).dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('★`./` 开头的相对路径 —— 模型最常这么写', () => {
    expect(readImageRef([ws], './out/chart.png')).toHaveProperty('dataUrl')
  })

  it('★★绝对路径(base 之内)也要能读 —— 老实现用 join(cwd,file) 把它拼成了 <cwd>/Users/… 于是永远「文件不存在」', () => {
    const r = readImageRef([ws], join(ws, 'out', 'chart.png'))
    expect(r).toHaveProperty('dataUrl')
  })

  it('★越界的绝对路径必须拒 —— 手机/远程主机都能连进来,这是个文件读取面', () => {
    expect(readImageRef([ws], join(outside, 'secret.png'))).toEqual({ error: '不在工作区内' })
  })

  it('★`../` 穿越也算越界', () => {
    expect(readImageRef([ws], '../outside/secret.png')).toEqual({ error: '不在工作区内' })
  })

  it('多个 base 按优先级回退(会话 worktree → 工作区根)', () => {
    expect(readImageRef([join(ws, 'out'), ws], 'notes.md')).toEqual({ error: '不是支持的图片格式' })
    expect(readImageRef([join(ws, 'nope'), ws], 'out/chart.png')).toHaveProperty('dataUrl')
  })

  it('不是图片扩展名 → 拒(别把任意文件读成 data URL)', () => {
    expect(readImageRef([ws], 'notes.md')).toEqual({ error: '不是支持的图片格式' })
  })

  it('文件不存在 → 明确说不存在,不说越界', () => {
    expect(readImageRef([ws], 'out/nope.png')).toEqual({ error: '文件不存在' })
  })

  it('没有 base 时不读任何东西', () => {
    expect(readImageRef([], 'out/chart.png')).toEqual({ error: '路径无效' })
  })

  it('体积上限', () => {
    expect(readImageRef([ws], 'out/chart.png', { maxBytes: 10 })).toEqual({ error: '图片过大' })
  })
})

// ★★2026-11 用户报:模型写 `![bcd](/tmp/g9/v/bcd.png)`(文件当时就在),对话里只有 🖼 + 路径。
// 根因:readImageRef 只认工作区 bases 之内 → /tmp 是「不在工作区内」。本机窗口要能看模型产出的任何本地图;
// 远程/手机连进来的调用方仍然只给工作区之内(allowOutside 只在 client.id === 'local' 时由 handler 打开)。
describe('readImageRef — 本机窗口里工作区之外的本地图', () => {
  let home = ''
  beforeAll(() => {
    home = join(root, 'home')
    mkdirSync(join(home, 'pics', 'dir.png'), { recursive: true })
    writeFileSync(join(home, 'pics', 'a.png'), PNG)
    writeFileSync(join(outside, 'fake.png'), 'just some text, not an image')
    writeFileSync(join(outside, 'notes.txt'), 'secret text')
    writeFileSync(join(outside, 'big.png'), Buffer.concat([PNG, Buffer.alloc(64)]))
    symlinkSync(join(outside, 'notes.txt'), join(outside, 'link.png'))
    symlinkSync(join(outside, 'secret.png'), join(ws, 'escape.png'))
    const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46])
    writeFileSync(join(outside, 'p.jpg'), JPG)
    writeFileSync(join(outside, 'p.gif'), Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))
    writeFileSync(join(outside, 'p.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))
    writeFileSync(join(outside, 'p.bmp'), Buffer.concat([Buffer.from('BM'), Buffer.alloc(20)]))
  })
  const local = { allowOutside: true, home: () => home }

  it('★★绝对路径(/tmp/… 这类工作区之外)→ data URL', () => {
    expect(readImageRef([ws], join(outside, 'secret.png'), local)).toHaveProperty('dataUrl')
  })
  it('★★file:// URL → data URL', () => {
    expect(readImageRef([ws], 'file://' + join(outside, 'secret.png'), local)).toHaveProperty('dataUrl')
  })
  it('★★~/ 路径按 home 展开', () => {
    expect(readImageRef([ws], '~/pics/a.png', local)).toHaveProperty('dataUrl')
  })
  it('没有 base 时,本机窗口的绝对路径照样能读', () => {
    expect(readImageRef([], join(outside, 'secret.png'), local)).toHaveProperty('dataUrl')
  })
  it('jpg / gif / webp / bmp 都认', () => {
    for (const f of ['p.jpg', 'p.gif', 'p.webp', 'p.bmp']) expect(readImageRef([], join(outside, f), local)).toHaveProperty('dataUrl')
  })
  it('★远程调用方(allowOutside 关)仍然拒工作区之外', () => {
    expect(readImageRef([ws], join(outside, 'secret.png'), { home: () => home })).toEqual({ error: '不在工作区内' })
    expect(readImageRef([ws], '~/pics/a.png', { home: () => home })).toEqual({ error: '不在工作区内' })
  })
  it('.txt 拒', () => {
    expect(readImageRef([], join(outside, 'notes.txt'), local)).toEqual({ error: '不是支持的图片格式' })
  })
  it('★扩展名是 .png 但内容不是图片 → 拒(看魔数)', () => {
    expect(readImageRef([], join(outside, 'fake.png'), local)).toEqual({ error: '不是图片' })
  })
  it('★指向非图片的符号链接(link.png → notes.txt)→ 拒', () => {
    expect(readImageRef([], join(outside, 'link.png'), local)).toHaveProperty('error')
    expect(readImageRef([], join(outside, 'link.png'), local)).not.toHaveProperty('dataUrl')
  })
  it('★★工作区里的符号链接逃到工作区外 → 远程调用方拒', () => {
    expect(readImageRef([ws], 'escape.png')).toEqual({ error: '不在工作区内' })
  })
  it('目录(哪怕叫 dir.png)→ 拒', () => {
    expect(readImageRef([], join(home, 'pics', 'dir.png'), local)).toEqual({ error: '这是个目录' })
  })
  it('文件不存在 → 文件不存在(渲染层退回占位符)', () => {
    expect(readImageRef([], join(outside, 'nope.png'), local)).toEqual({ error: '文件不存在' })
  })
  it('超过体积上限 → 拒', () => {
    expect(readImageRef([], join(outside, 'big.png'), { ...local, maxBytes: PNG.length + 10 })).toEqual({ error: '图片过大' })
  })
  it('路径里带 NUL → 拒', () => {
    expect(readImageRef([], join(outside, 'secret.png') + '\0.png', local)).toEqual({ error: '路径无效' })
  })
  it('本机窗口里相对路径仍按 base 解析,../ 穿越照样拒', () => {
    expect(readImageRef([ws], 'out/chart.png', local)).toHaveProperty('dataUrl')
    expect(readImageRef([ws], '../outside/secret.png', local)).toEqual({ error: '不在工作区内' })
  })
})

describe('imageOptsFor — 谁能读工作区之外', () => {
  it('★只有本机窗口(id === local)放行', () => {
    expect(imageOptsFor({ id: 'local', label: '本机' }).allowOutside).toBe(true)
    expect(imageOptsFor({ id: 'local', label: '本机', fromOverlay: true }).allowOutside).toBe(true)
  })
  it('★远程连接、未知调用方一律不放行', () => {
    expect(imageOptsFor({ id: 'c-123', label: '手机' }).allowOutside).toBe(false)
    expect(imageOptsFor(undefined).allowOutside).toBe(false)
  })
})
