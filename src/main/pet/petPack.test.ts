import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPetPack, readPetImage } from './petPack'

describe('readPetPack', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pet-pack-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads valid images and returns correct data URLs with mime types', () => {
    const pngBytes = Buffer.from('fakepng')
    const gifBytes = Buffer.from('fakegif')
    writeFileSync(join(dir, 'idle.png'), pngBytes)
    writeFileSync(join(dir, 'working.gif'), gifBytes)

    const result = readPetPack(dir, { maxBytes: 100 })

    expect(result.idle).toBe(`data:image/png;base64,${pngBytes.toString('base64')}`)
    expect(result.working).toBe(`data:image/gif;base64,${gifBytes.toString('base64')}`)
    expect(result.confirm).toBeUndefined()
    expect(result.input).toBeUndefined()
    expect(result.done).toBeUndefined()
  })

  it('skips files exceeding maxBytes', () => {
    const smallBytes = Buffer.alloc(10, 0xff)
    const bigBytes = Buffer.alloc(50, 0xff)
    writeFileSync(join(dir, 'idle.png'), smallBytes)
    writeFileSync(join(dir, 'done.png'), bigBytes)

    const result = readPetPack(dir, { maxBytes: 20 })

    expect(result.idle).toMatch(/^data:image\/png;base64,/)
    expect(result.done).toBeUndefined()
  })

  it('ignores unrelated files like foo.txt', () => {
    writeFileSync(join(dir, 'foo.txt'), 'hello')
    writeFileSync(join(dir, 'idle.png'), Buffer.from('x'))

    const result = readPetPack(dir, { maxBytes: 100 })

    expect(Object.keys(result)).toEqual(['idle'])
  })

  it('supports svg and webp extensions with correct mime types', () => {
    writeFileSync(join(dir, 'confirm.svg'), Buffer.from('<svg/>'))
    writeFileSync(join(dir, 'input.webp'), Buffer.from('webpdata'))

    const result = readPetPack(dir, { maxBytes: 100 })

    expect(result.confirm).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(result.input).toMatch(/^data:image\/webp;base64,/)
  })

  it('picks first matching extension if multiple exist (png before gif)', () => {
    writeFileSync(join(dir, 'idle.png'), Buffer.from('png'))
    writeFileSync(join(dir, 'idle.gif'), Buffer.from('gif'))

    const result = readPetPack(dir, { maxBytes: 100 })

    expect(result.idle).toMatch(/^data:image\/png;base64,/)
  })

  it('uses default maxBytes of 2_000_000 when not specified', () => {
    writeFileSync(join(dir, 'idle.png'), Buffer.alloc(1_000))

    const result = readPetPack(dir)

    expect(result.idle).toMatch(/^data:image\/png;base64,/)
  })

  it('falls through to gif when png exceeds maxBytes', () => {
    const bigPng = Buffer.alloc(50, 0xaa)
    const smallGif = Buffer.from('fakegifdata')
    writeFileSync(join(dir, 'idle.png'), bigPng)
    writeFileSync(join(dir, 'idle.gif'), smallGif)

    const result = readPetPack(dir, { maxBytes: 20 })

    // oversized png is skipped; gif fallback is used
    expect(result.idle).toBe(`data:image/gif;base64,${smallGif.toString('base64')}`)
  })
})

describe('readPetImage', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pet-image-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a png into a data URL', () => {
    const bytes = Buffer.from('fakepng')
    const p = join(dir, 'cat.png')
    writeFileSync(p, bytes)
    expect(readPetImage(p)).toEqual({ dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })
  })

  it('maps each supported extension to its mime type', () => {
    for (const [ext, mime] of [['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['webp', 'image/webp']] as const) {
      const p = join(dir, `a.${ext}`)
      writeFileSync(p, Buffer.from('x'))
      const r = readPetImage(p)
      expect(r).toEqual({ dataUrl: `data:${mime};base64,${Buffer.from('x').toString('base64')}` })
    }
  })

  it('rejects unsupported extensions with an error', () => {
    const p = join(dir, 'a.jpg')
    writeFileSync(p, Buffer.from('x'))
    const r = readPetImage(p)
    expect(r).toEqual({ error: '不支持的图片格式,仅支持 png/gif/svg/webp' })
  })

  it('rejects files exceeding maxBytes with an error', () => {
    const p = join(dir, 'big.png')
    writeFileSync(p, Buffer.alloc(50, 0xff))
    const r = readPetImage(p, { maxBytes: 20 })
    expect(r).toEqual({ error: '图片超过大小上限(2MB)' })
  })

  it('rejects a missing file with an error', () => {
    const r = readPetImage(join(dir, 'nope.png'))
    expect(r).toEqual({ error: '文件不存在或无法读取' })
  })
})
