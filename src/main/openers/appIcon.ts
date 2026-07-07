import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const pexec = promisify(execFile)

// Read the app bundle's declared icon file name (Info.plist → CFBundleIconFile), e.g. "Code" or
// "Code.icns". `defaults` reads both XML and binary plists. Returns null when the key is absent
// (some system apps ship their icon in a compiled Assets.car instead of a standalone .icns).
async function bundleIconName(appPath: string): Promise<string | null> {
  try {
    const { stdout } = await pexec('defaults', ['read', join(appPath, 'Contents', 'Info'), 'CFBundleIconFile'])
    return stdout.trim() || null
  } catch { return null }
}

// macOS: read an app's REAL icon as a 64px PNG dataURL by rasterizing its bundle .icns with `sips`.
//
// Why not app.getFileIcon: on some macOS builds getFileIcon returns a generic placeholder — the
// SAME blank rounded-square for every app — which renders as an empty-looking icon in the dropdown.
// Reading the bundle's own .icns sidesteps NSWorkspace entirely and yields the true per-app icon.
//
// Best-effort: returns undefined (caller falls back to getFileIcon, then to a folder glyph) whenever
// the app has no standalone .icns or the conversion fails. Never throws.
export async function readMacAppIcon(appPath: string): Promise<string | undefined> {
  let name = await bundleIconName(appPath)
  if (!name) return undefined
  if (!name.toLowerCase().endsWith('.icns')) name += '.icns'
  const icns = join(appPath, 'Contents', 'Resources', name)
  if (!existsSync(icns)) return undefined
  // Unique temp path per bundle so concurrent scans don't clobber each other's output.
  const out = join(tmpdir(), `forge-opener-icon-${Buffer.from(appPath).toString('base64url').slice(0, 32)}.png`)
  try {
    await pexec('sips', ['-s', 'format', 'png', icns, '--out', out, '-Z', '64'])
    const buf = await readFile(out)
    if (!buf.length) return undefined
    return 'data:image/png;base64,' + buf.toString('base64')
  } catch {
    return undefined
  } finally {
    try { await unlink(out) } catch { /* temp file may not exist — ignore */ }
  }
}
