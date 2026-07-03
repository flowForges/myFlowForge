import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { sysFile } from '../config/paths'
import type { Pet } from '../config/schema'

// Supported raster/vector formats, mirrored from petPack.ts. The stored file keeps the source
// extension so the custom protocol can serve the right content-type.
export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}
const EXT_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]),
)

// Custom pet images live under ~/.myFlowForge/pet-images/<petId>/<state>.<ext>, keeping them OUT of
// settings.json (which previously inlined multi-MB base64 data URLs and bloated every read/write).
export const petImagesDir = (): string => sysFile('pet-images')

export function isDataUrl(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith('data:')
}

// The stored value + protocol path: "<petId>/<state>.<ext>" (POSIX-style, safe as a URL segment).
export function petImageRelPath(petId: string, state: string, ext: string): string {
  return `${petId}/${state}.${ext}`
}

// Only allow filename-safe id segments in the on-disk path (ids are app-generated, but guard anyway).
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_')
}

// Decode a data URL into its mime/ext/bytes. Returns null for anything that isn't a supported image.
export function parseImageDataUrl(dataUrl: string): { mime: string; ext: string; buffer: Buffer } | null {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!m) return null
  const mime = m[1]
  const ext = EXT_BY_MIME[mime]
  if (!ext) return null
  const buffer = m[2]
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  return { mime, ext, buffer }
}

// Write a data URL to disk under pet-images and return the stored relative path (or null if the
// data URL is unsupported). Removes any sibling <state>.<otherExt> first so switching an image's
// format never leaves a stale file that the fallback chain might pick up.
export function writePetImageFromDataUrl(
  petId: string,
  state: string,
  dataUrl: string,
  baseDir: string = petImagesDir(),
): string | null {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) return null
  const id = safeSegment(petId)
  const dir = join(baseDir, id)
  mkdirSync(dir, { recursive: true })
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const sibling = join(dir, `${state}.${ext}`)
    if (existsSync(sibling)) { try { rmSync(sibling) } catch { /* best-effort */ } }
  }
  const rel = petImageRelPath(id, state, parsed.ext)
  writeFileSync(join(baseDir, rel), parsed.buffer)
  return rel
}

// Resolve a stored relative path to an absolute path INSIDE pet-images, or null if it would escape
// (path-traversal guard for the protocol handler).
export function resolvePetImageAbs(rel: string, baseDir: string = petImagesDir()): string | null {
  const root = resolve(baseDir)
  const abs = resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + sep)) return null
  return abs
}

// One-time migration: convert any inline data-URL pet images (customPets[].images and the legacy
// singular customImages) into files on disk, replacing each value with its relative path. Returns a
// new Pet plus the number of images moved (0 → nothing to write back). Pure w.r.t. the input object.
export function migratePetImagesInPet(
  pet: Pet,
  baseDir: string = petImagesDir(),
): { pet: Pet; migrated: number } {
  let migrated = 0
  const convert = (
    images: Partial<Record<string, string>> | undefined,
    ownerId: string,
  ): Partial<Record<string, string>> | undefined => {
    if (!images) return images
    const out: Record<string, string> = {}
    for (const [state, val] of Object.entries(images)) {
      if (val === undefined) continue
      if (isDataUrl(val)) {
        const rel = writePetImageFromDataUrl(ownerId, state, val, baseDir)
        if (rel) { out[state] = rel; migrated++; continue }
      }
      out[state] = val
    }
    return out
  }
  const customPets = (pet.customPets ?? []).map(p => ({ ...p, images: convert(p.images, p.id) as Pet['customPets'][number]['images'] }))
  const customImages = convert(pet.customImages, 'legacy') as Pet['customImages']
  return { pet: { ...pet, customPets, customImages }, migrated }
}
