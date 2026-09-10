import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readImageRef } from './imageRef'

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
