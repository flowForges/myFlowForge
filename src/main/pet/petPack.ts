import { statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PET_STATES } from '../config/schema'
import type { PetState } from '../config/schema'

const EXTENSIONS = ['png', 'gif', 'svg', 'webp'] as const
type Ext = (typeof EXTENSIONS)[number]

const MIME: Record<Ext, string> = {
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
}

export interface ReadPetPackOpts {
  maxBytes?: number
}

export type PetImageResult = { dataUrl: string } | { error: string }

/**
 * Reads a single image file into a data URL, for the "upload one image as a pet" flow.
 * Same format whitelist and size cap as readPetPack; returns a user-facing error string
 * (rather than undefined) so the settings UI can explain why an upload was rejected.
 */
export function readPetImage(filePath: string, opts?: ReadPetPackOpts): PetImageResult {
  const maxBytes = opts?.maxBytes ?? 2_000_000
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase() as Ext
  const mime = MIME[ext]
  if (!mime) return { error: '不支持的图片格式,仅支持 png/gif/svg/webp' }
  if (!existsSync(filePath)) return { error: '文件不存在或无法读取' }
  if (statSync(filePath).size > maxBytes) return { error: '图片超过大小上限(2MB)' }
  const bytes = readFileSync(filePath)
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }
}

/**
 * Reads a pet pack directory, converting each found state image into a data URL.
 * For each PET_STATE, checks <dir>/<state>.<ext> for ext in [png, gif, svg, webp].
 * Skips files exceeding maxBytes (default 2_000_000). Returns only states with valid images.
 */
export function readPetPack(
  dir: string,
  opts?: ReadPetPackOpts,
): Partial<Record<PetState, string>> {
  const maxBytes = opts?.maxBytes ?? 2_000_000
  const result: Partial<Record<PetState, string>> = {}

  for (const state of PET_STATES) {
    for (const ext of EXTENSIONS) {
      const filePath = join(dir, `${state}.${ext}`)
      if (!existsSync(filePath)) continue
      const r = readPetImage(filePath, { maxBytes })
      if ('dataUrl' in r) {
        result[state] = r.dataUrl
        break // first within-limit match wins
      }
      // oversized — try next extension
    }
  }

  return result
}
