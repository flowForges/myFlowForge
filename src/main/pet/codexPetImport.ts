import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseCodexManifest } from '@shared/codexPetManifest'
import type { CustomPet } from '@shared/petCustom'
import { petImagesDir, petImageRelPath } from './petImageStore'

// Only filename-safe id segments touch the on-disk path.
function safeId(s: string): string { return s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_') }

// Read + validate a pack directory's pet.json, copy its spritesheet into pet-images/<id>/spritesheet.webp,
// and return a CustomPet carrying the atlas ref. Directory input only (no zip).
export function importCodexPetPack(
  srcDir: string,
  baseDir: string = petImagesDir(),
): { ok: true; pet: CustomPet } | { ok: false; error: string } {
  const manifestPath = join(srcDir, 'pet.json')
  if (!existsSync(manifestPath)) return { ok: false, error: '目录下没有 pet.json' }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { return { ok: false, error: 'pet.json 解析失败' } }
  const parsed = parseCodexManifest(raw)
  if (!parsed.ok) return parsed
  const m = parsed.manifest
  const sheetSrc = join(srcDir, m.spritesheetPath)
  if (!existsSync(sheetSrc)) return { ok: false, error: `找不到精灵图 ${m.spritesheetPath}` }
  const id = safeId(m.id)
  const destDir = join(baseDir, id)
  mkdirSync(destDir, { recursive: true })
  const rel = petImageRelPath(id, 'spritesheet', 'webp')  // "<id>/spritesheet.webp"
  writeFileSync(join(baseDir, rel), readFileSync(sheetSrc))
  return { ok: true, pet: { id, name: m.displayName, atlas: { path: rel, version: 2 } } }
}

// List Codex pet packs under ${CODEX_HOME:-~/.codex}/pets/*. Skips entries without a valid v2 manifest.
export function discoverCodexPets(codexHome?: string): { id: string; displayName: string; dir: string }[] {
  const home = codexHome ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')
  const petsDir = join(home, 'pets')
  if (!existsSync(petsDir)) return []
  const out: { id: string; displayName: string; dir: string }[] = []
  for (const entry of readdirSync(petsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(petsDir, entry.name)
    const manifestPath = join(dir, 'pet.json')
    if (!existsSync(manifestPath)) continue
    try {
      const parsed = parseCodexManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
      if (parsed.ok) out.push({ id: parsed.manifest.id, displayName: parsed.manifest.displayName, dir })
    } catch { /* skip unreadable */ }
  }
  return out
}
