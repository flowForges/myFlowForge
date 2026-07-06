import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { APP_ICON_OPTIONS, MENU_BAR_ICON_FILENAME, resolveAppIconOptions, resolveDockIconPath, resolveMenuBarIconPath } from './appIcon'

function pngAlphaReader(file: string) {
  const b = readFileSync(file)
  const width = b.readUInt32BE(16)
  const height = b.readUInt32BE(20)
  const colorType = b[25]
  expect(colorType).toBe(6)
  const idat: Buffer[] = []
  for (let pos = 8; pos < b.length;) {
    const len = b.readUInt32BE(pos)
    const type = b.toString('ascii', pos + 4, pos + 8)
    if (type === 'IDAT') idat.push(b.subarray(pos + 8, pos + 8 + len))
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = 4
  const stride = width * bpp
  const out = Buffer.alloc(width * height * bpp)
  let rp = 0
  let op = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const row = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0
      const up = prev[x] || 0
      const upLeft = x >= bpp ? prev[x - bpp] : 0
      let predict = 0
      if (filter === 1) predict = left
      else if (filter === 2) predict = up
      else if (filter === 3) predict = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predict = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      row[x] = (raw[rp++] + predict) & 255
    }
    row.copy(out, op)
    op += stride
    prev = row
  }
  return {
    alphaAt: (x: number, y: number) => out[(y * width + x) * bpp + 3],
    height,
    width,
  }
}

function cornerAlphas(file: string) {
  const png = pngAlphaReader(file)
  return [png.alphaAt(0, 0), png.alphaAt(png.width - 1, 0), png.alphaAt(0, png.height - 1), png.alphaAt(png.width - 1, png.height - 1)]
}

function roundedShoulderAlphas(file: string) {
  const png = pngAlphaReader(file)
  const scale = png.width / 512
  return [
    png.alphaAt(Math.round(20 * scale), Math.round(60 * scale)),
    png.alphaAt(Math.round(40 * scale), Math.round(20 * scale)),
    png.alphaAt(Math.round(60 * scale), Math.round(20 * scale)),
  ]
}

function pngSize(file: string) {
  const b = readFileSync(file)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] }
}

describe('appIcon assets', () => {
  it('exposes the five selectable dock icons in display order', () => {
    expect(APP_ICON_OPTIONS.map(o => o.id)).toEqual(['ice-cyan', 'forge-aurora', 'cobalt-violet', 'ember-violet', 'magenta-pulse'])
  })

  it('resolves unknown dock icon ids to the default fourth icon', () => {
    expect(resolveDockIconPath({ resourcesPath: '/App/Contents/Resources', appPath: '/repo', isPackaged: true }, 'banana' as never))
      .toBe('/App/Contents/Resources/app-icons/flowforge-ember-violet.png')
  })

  it('resolves dev and packaged menu bar icon paths', () => {
    expect(resolveMenuBarIconPath({ resourcesPath: '/App/Contents/Resources', appPath: '/repo', isPackaged: true }))
      .toBe(`/App/Contents/Resources/app-icons/${MENU_BAR_ICON_FILENAME}`)
    expect(resolveMenuBarIconPath({ resourcesPath: '/unused', appPath: '/repo', isPackaged: false }))
      .toBe(`/repo/build/app-icons/${MENU_BAR_ICON_FILENAME}`)
  })

  it('returns preview URLs from the shared app-icons resource folder', () => {
    expect(resolveAppIconOptions({ resourcesPath: '/App/Contents/Resources', appPath: '/repo', isPackaged: true }).map(o => o.src)).toEqual([
      'file:///App/Contents/Resources/app-icons/flowforge-ice-cyan.png',
      'file:///App/Contents/Resources/app-icons/flowforge-forge-aurora.png',
      'file:///App/Contents/Resources/app-icons/flowforge-cobalt-violet.png',
      'file:///App/Contents/Resources/app-icons/flowforge-ember-violet.png',
      'file:///App/Contents/Resources/app-icons/flowforge-magenta-pulse.png',
    ])
  })

  it('ships transparent-corner dock icon PNGs', () => {
    for (const opt of APP_ICON_OPTIONS) {
      expect(cornerAlphas(join(process.cwd(), 'build', 'app-icons', opt.filename))).toEqual([0, 0, 0, 0])
      expect(roundedShoulderAlphas(join(process.cwd(), 'build', 'app-icons', opt.filename))).toEqual([0, 0, 0])
    }
    expect(cornerAlphas(join(process.cwd(), 'build', 'icon.png'))).toEqual([0, 0, 0, 0])
  })

  it('gives the DOCK icons a transparent safe-area margin so they are not oversized in the Dock', () => {
    // The running app sets its Dock icon from these (app.dock.setIcon). They must follow the macOS
    // Big Sur grid — artwork ~80% with a transparent margin — NOT edge-to-edge, or the Dock icon
    // reads larger than convention-following apps. The bundle icon.png stays full-tile (see below).
    for (const opt of APP_ICON_OPTIONS) {
      const png = pngAlphaReader(join(process.cwd(), 'build', 'app-icons', opt.filename))
      expect(png.alphaAt(Math.round(png.width / 2), 3)).toBe(0)       // transparent top margin
      expect(png.alphaAt(3, Math.round(png.height / 2))).toBe(0)      // transparent left margin
      expect(png.alphaAt(Math.round(png.width / 2), Math.round(png.height / 2))).toBe(255)  // opaque body
    }
  })

  it('ships a full-tile system app icon for Finder and DMG windows', () => {
    const png = pngAlphaReader(join(process.cwd(), 'build', 'icon.png'))
    expect(png.alphaAt(Math.round(png.width / 2), 5)).toBe(255)
    expect(png.alphaAt(5, Math.round(png.height / 2))).toBe(255)
    expect(png.alphaAt(Math.round(png.width / 2), Math.round(png.height / 2))).toBe(255)
  })

  it('ships a compact macOS menu bar template icon', () => {
    expect(pngSize(join(process.cwd(), 'build', 'app-icons', MENU_BAR_ICON_FILENAME))).toEqual({ width: 18, height: 18, colorType: 6 })
  })
})
