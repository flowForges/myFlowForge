import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import { parseCodexManifest } from '@shared/codexPetManifest'
import type { CustomPet } from '@shared/petCustom'
import { petImagesDir, petImageRelPath } from './petImageStore'

// Only filename-safe id segments touch the on-disk path.
function safeId(s: string): string { return s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_') }

// Stable short hash (djb2) of a string → base36. Lets two packs that ship the SAME manifest id
// (e.g. scaffolds shipping id "default"/"pet") but live in different folders get distinct storage
// keys, so their spritesheets never clobber each other in pet-images/<id>/.
function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Identity of an imported codex pet = its SOURCE FOLDER, not the manifest id. Consequences:
//  - re-importing the same folder (or re-clicking the same discovered pet) yields the SAME id, so the
//    gallery upserts/selects the existing entry instead of appending a duplicate.
//  - two different packs that share a manifest id get DIFFERENT ids (folder path differs) → no clobber.
//  - the `codex-` prefix lets the pet gallery group codex pets into their own section.
export function codexPetId(srcDir: string): string {
  const abs = resolve(srcDir)
  return `codex-${safeId(basename(abs))}-${shortHash(abs)}`
}

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
  const id = codexPetId(srcDir)
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
