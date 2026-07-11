// Local mock of the NSFW content Worker — for verifying the app-side flow WITHOUT any Cloudflare setup.
// It speaks the same 4 endpoints as cloudflare/nsfw-worker.js. Run it, point the app at it, test.
//
//   node cloudflare/nsfw-mock-server.mjs           # listens on http://localhost:8787
//
// Then set src/shared/nsfw.ts →  export const NSFW_WORKER_URL = 'http://localhost:8787'
// and run the app in dev (npm run dev). Test activation code:  TEST-1234
//
// Images: if a ./cloudflare/mock-content/ folder exists it serves real files
//   (pets/<id>/<state>.webp|png , bg/<id>.webp|png); otherwise it serves a generated solid-colour PNG
//   so the flow still works (you'll just see coloured squares instead of art).

import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'

const PORT = 8787
const CODES = new Set(['TEST-1234']) // valid activation codes for the mock
const HERE = dirname(fileURLToPath(import.meta.url))
const CONTENT_DIR = join(HERE, 'mock-content')

const CATALOG = {
  pets: [
    { id: 'demo-pet', name: '测试宠物', states: ['idle', 'working', 'confirm', 'input', 'done'] },
  ],
  backgrounds: [
    { id: 'demo-bg', name: '测试背景' },
  ],
}

// ── tiny solid-colour PNG generator (no deps) so the mock works with zero art ───────────────────────
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
  const row = Buffer.alloc(1 + size * 4); for (let x = 0; x < size; x++) { const o = 1 + x * 4; row[o] = r; row[o + 1] = g; row[o + 2] = b; row[o + 3] = 255 }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const COLORS = { idle: [120, 170, 255], working: [255, 180, 90], confirm: [255, 120, 120], input: [180, 140, 255], done: [120, 220, 150], bg: [90, 110, 140] }

function servedImage(kind, state) {
  // Prefer a real file from mock-content/ if present.
  for (const ext of ['webp', 'png', 'gif', 'jpg']) {
    const p = kind.startsWith('pet') ? join(CONTENT_DIR, 'pets', kind.slice(4), `${state}.${ext}`) : join(CONTENT_DIR, 'bg', `${kind.slice(3)}.${ext}`)
    if (existsSync(p)) return { bytes: readFileSync(p), ct: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }
  }
  const colour = COLORS[kind.startsWith('pet') ? (state || 'idle') : 'bg'] || COLORS.idle
  return { bytes: solidPng(kind.startsWith('pet') ? 128 : 512, colour), ct: 'image/png' }
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname
  if (req.method === 'POST' && p === '/unlock') {
    let code = ''; try { code = JSON.parse(await body(req)).code } catch { /* */ }
    return CODES.has((code || '').trim()) ? json(res, 200, { ok: true }) : json(res, 403, { ok: false })
  }
  const key = url.searchParams.get('key')
  if (!CODES.has((key || '').trim())) return json(res, 403, { error: 'forbidden' })
  if (p === '/catalog') return json(res, 200, CATALOG)
  let m = p.match(/^\/content\/pet\/([^/]+)\/([^/]+)$/)
  if (m) { const img = servedImage('pet:' + m[1], m[2]); res.writeHead(200, { 'content-type': img.ct }); return res.end(img.bytes) }
  m = p.match(/^\/content\/bg\/([^/]+)$/)
  if (m) { const img = servedImage('bg:' + m[1]); res.writeHead(200, { 'content-type': img.ct }); return res.end(img.bytes) }
  json(res, 404, { error: 'not found' })
}).listen(PORT, () => console.log(`NSFW mock server → http://localhost:${PORT}  (test code: TEST-1234)`))

function body(req) { return new Promise(r => { let d = ''; req.on('data', c => (d += c)); req.on('end', () => r(d)) }) }
