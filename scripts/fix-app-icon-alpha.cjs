#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const args = process.argv.slice(2)
const fillRoundedTile = args.includes('--fill-rounded-tile')
const radiusArg = args.find(arg => arg.startsWith('--radius='))
const radiusRatio = radiusArg ? Number(radiusArg.slice('--radius='.length)) : 0.305
const files = args.filter(arg => arg !== '--fill-rounded-tile' && !arg.startsWith('--radius='))
if (files.length === 0) {
  console.error('usage: node scripts/fix-app-icon-alpha.cjs <png> [...]')
  process.exit(1)
}

const crcTable = (() => {
  const table = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const name = Buffer.from(type)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([len, name, data, crc])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function decodePng(file) {
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error(`${file} is not a PNG`)
  }
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const bitDepth = buf[24]
  const colorType = buf[25]
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${file} must be 8-bit RGB/RGBA PNG; got bit=${bitDepth} color=${colorType}`)
  }
  const bpp = colorType === 6 ? 4 : 3
  const idat = []
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len))
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * bpp
  const pixels = Buffer.alloc(width * height * bpp)
  let rawPos = 0
  let outPos = 0
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++]
    const row = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? row[x - bpp] : 0
      const up = prev[x] || 0
      const upLeft = x >= bpp ? prev[x - bpp] : 0
      const predict = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : paeth(left, up, upLeft)
      row[x] = (raw[rawPos++] + predict) & 255
    }
    row.copy(pixels, outPos)
    outPos += stride
    prev = row
  }
  return { width, height, bpp, pixels }
}

function encodeRgbaPng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function findBrightBounds(img) {
  let minX = img.width
  let minY = img.height
  let maxX = 0
  let maxY = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.bpp
      if (Math.max(img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]) <= 70) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  if (minX > maxX || minY > maxY) return { x: 0, y: 0, size: Math.min(img.width, img.height) }
  const size = Math.min(Math.max(maxX - minX + 1, maxY - minY + 1), Math.min(img.width, img.height))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return {
    x: Math.max(0, Math.min(img.width - size, Math.round(cx - size / 2))),
    y: Math.max(0, Math.min(img.height - size, Math.round(cy - size / 2))),
    size,
  }
}

function sample(img, x, y, channel) {
  x = Math.max(0, Math.min(img.width - 1, x))
  y = Math.max(0, Math.min(img.height - 1, y))
  const i = (y * img.width + x) * img.bpp
  return channel === 3 ? (img.bpp === 4 ? img.pixels[i + 3] : 255) : img.pixels[i + channel]
}

function resampleCropToRgba(img, crop, outSize) {
  const out = Buffer.alloc(outSize * outSize * 4)
  const scale = crop.size / outSize
  for (let y = 0; y < outSize; y++) {
    const sy = crop.y + (y + 0.5) * scale - 0.5
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let x = 0; x < outSize; x++) {
      const sx = crop.x + (x + 0.5) * scale - 0.5
      const x0 = Math.floor(sx)
      const fx = sx - x0
      const oi = (y * outSize + x) * 4
      for (let c = 0; c < 4; c++) {
        const a = sample(img, x0, y0, c)
        const b = sample(img, x0 + 1, y0, c)
        const d = sample(img, x0, y0 + 1, c)
        const e = sample(img, x0 + 1, y0 + 1, c)
        out[oi + c] = Math.round((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy)
      }
    }
  }
  return out
}

function roundedRectAlpha(x, y, size) {
  // Generated icon tiles have a large macOS-style squircle corner. A small radius leaves the
  // source image's dark rectangular backdrop visible around the glass tile.
  const radius = Math.round(size * radiusRatio)
  const feather = Math.max(1.5, size * 0.002)
  const px = x + 0.5
  const py = y + 0.5
  const cx = Math.max(radius, Math.min(size - radius, px))
  const cy = Math.max(radius, Math.min(size - radius, py))
  const dist = Math.hypot(px - cx, py - cy)
  const signed = dist - radius
  if (signed <= -feather) return 1
  if (signed >= feather) return 0
  return 0.5 - signed / (2 * feather)
}

function fixFile(file) {
  const img = decodePng(file)
  const crop = findBrightBounds(img)
  const out = resampleCropToRgba(img, crop, img.width)
  const tileBg = [8, 10, 29]
  for (let y = 0; y < img.width; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4
      const maskAlpha = roundedRectAlpha(x, y, img.width)
      if (fillRoundedTile) {
        const sourceAlpha = out[i + 3] / 255
        out[i] = Math.round(out[i] * sourceAlpha + tileBg[0] * (1 - sourceAlpha))
        out[i + 1] = Math.round(out[i + 1] * sourceAlpha + tileBg[1] * (1 - sourceAlpha))
        out[i + 2] = Math.round(out[i + 2] * sourceAlpha + tileBg[2] * (1 - sourceAlpha))
        out[i + 3] = Math.round(255 * maskAlpha)
      } else {
        out[i + 3] = Math.round(out[i + 3] * maskAlpha)
      }
    }
  }
  fs.writeFileSync(file, encodeRgbaPng(img.width, img.width, out))
  return crop
}

for (const file of files) {
  const crop = fixFile(file)
  console.log(`${path.basename(file)} crop x=${crop.x} y=${crop.y} size=${crop.size}`)
}
