// Build build/icon.ico (the Windows app + installer icon) from build/icon.png.
//
// Why a script and not a checked-in binary someone made once in an editor: the .ico has to stay in
// sync with the macOS icon, and regenerating it must not require a Windows machine or ImageMagick.
// `sips` (macOS built-in) does the resizing; the ICO container is assembled here — it is a 6-byte
// header plus a 16-byte directory entry per image, and every entry may hold a plain PNG (supported
// since Windows Vista; we target Windows 10+).
//
// Run: node scripts/make-win-icon.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'build', 'icon.png')
const out = join(root, 'build', 'icon.ico')
// Explorer, the taskbar, alt-tab, the installer and the .exe's own properties dialog each pick a
// different one of these. Ship them all rather than let Windows downscale one badly.
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const work = mkdtempSync(join(tmpdir(), 'forge-ico-'))
try {
  const pngs = SIZES.map(size => {
    const file = join(work, `${size}.png`)
    execFileSync('sips', ['-s', 'format', 'png', src, '--out', file, '-z', String(size), String(size)], { stdio: 'pipe' })
    return { size, data: readFileSync(file) }
  })

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)            // reserved
  header.writeUInt16LE(1, 2)            // type 1 = icon
  header.writeUInt16LE(pngs.length, 4)

  const dir = Buffer.alloc(16 * pngs.length)
  let offset = header.length + dir.length
  pngs.forEach(({ size, data }, i) => {
    const at = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, at)      // 0 means 256 — the field is one byte
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
    dir.writeUInt8(0, at + 2)                        // palette colours (0 = truecolour)
    dir.writeUInt8(0, at + 3)                        // reserved
    dir.writeUInt16LE(1, at + 4)                     // colour planes
    dir.writeUInt16LE(32, at + 6)                    // bits per pixel
    dir.writeUInt32LE(data.length, at + 8)
    dir.writeUInt32LE(offset, at + 12)
    offset += data.length
  })

  writeFileSync(out, Buffer.concat([header, dir, ...pngs.map(p => p.data)]))
  console.log(`wrote ${out} (${SIZES.join('/')}px, ${(offset / 1024).toFixed(1)} KB)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
