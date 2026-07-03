#!/usr/bin/env node
const fs = require('node:fs')
const zlib = require('node:zlib')

const outPath = process.argv[2] || 'build/app-icons/flowforge-menubar-template.png'
const W = 18
const H = 18
const S = 6
const w = W * S
const h = H * S
const alpha = new Float32Array(w * h)

function mark(x, y, r, a = 1) {
  x *= S
  y *= S
  r *= S
  const minX = Math.max(0, Math.floor(x - r - 1))
  const maxX = Math.min(w - 1, Math.ceil(x + r + 1))
  const minY = Math.max(0, Math.floor(y - r - 1))
  const maxY = Math.min(h - 1, Math.ceil(y + r + 1))
  for (let yy = minY; yy <= maxY; yy++) {
    for (let xx = minX; xx <= maxX; xx++) {
      const d = Math.hypot(xx - x, yy - y)
      const edge = Math.max(0, Math.min(1, r + 0.75 - d))
      const i = yy * w + xx
      alpha[i] = Math.max(alpha[i], a * edge)
    }
  }
}

function line(x1, y1, x2, y2, r, a = 1) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * S * 1.4)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    mark(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, r, a)
  }
}

function bezier(p0, p1, p2, p3, r, a = 1) {
  let prev = p0
  for (let i = 1; i <= 60; i++) {
    const t = i / 60
    const mt = 1 - t
    const p = [
      mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
      mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
    ]
    line(prev[0], prev[1], p[0], p[1], r, a)
    prev = p
  }
}

bezier([9, 3.4], [8.7, 6.5], [8.7, 11.2], [8.7, 15], 0.82)
bezier([9, 3.7], [7, 6.2], [5.1, 8.3], [2.8, 8.9], 0.74)
bezier([9, 3.7], [11, 6.2], [12.9, 8.3], [15.2, 8.9], 0.74)
bezier([7, 7.6], [6.1, 9.4], [5.8, 11.8], [5.4, 14.2], 0.62)
bezier([11, 7.6], [11.9, 9.4], [12.2, 11.8], [12.6, 14.2], 0.62)
mark(9, 3.4, 1.75)
mark(8.7, 15, 1.2)
mark(2.8, 8.9, 1.15)
mark(15.2, 8.9, 1.15)
mark(5.4, 14.2, 1.05)
mark(12.6, 14.2, 1.05)

const rgba = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let sum = 0
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) sum += alpha[(y * S + sy) * w + x * S + sx]
    const i = (y * W + x) * 4
    rgba[i] = 0
    rgba[i + 1] = 0
    rgba[i + 2] = 0
    rgba[i + 3] = Math.max(0, Math.min(255, Math.round((sum / (S * S)) * 255)))
  }
}

const table = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
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

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8
ihdr[9] = 6
const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0
  rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}

fs.mkdirSync(require('node:path').dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]))
