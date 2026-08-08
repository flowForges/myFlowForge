// src/main/pet/growthPlaceholder.integration.test.ts
//
// Real end-to-end check that scripts/make-growth-placeholder.mjs produces a pack the actual
// installer accepts — not just "the script ran without throwing". Spawns the real script as a
// subprocess (exactly how a user would run it per the brief), then feeds its output through the
// REAL parseGrowthManifest + importGrowthPetPack, not a mock. If the generator ever drifts from
// what parseGrowthManifest requires (e.g. someone tweaks STAGES/actions in the script), this is
// the test that catches it — growthPetImport.test.ts only covers hand-written fixtures.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseGrowthManifest } from '@shared/growthPet'
import { importGrowthPetPack } from './growthPetImport'

const SCRIPT = resolve(__dirname, '../../../scripts/make-growth-placeholder.mjs')

let src: string
let dest: string

afterEach(() => {
  if (src) rmSync(src, { recursive: true, force: true })
  if (dest) rmSync(dest, { recursive: true, force: true })
})

describe('make-growth-placeholder.mjs output', () => {
  it('is accepted by parseGrowthManifest and importGrowthPetPack', () => {
    src = mkdtempSync(join(tmpdir(), 'growth-placeholder-src-'))
    dest = mkdtempSync(join(tmpdir(), 'growth-placeholder-dest-'))

    execFileSync(process.execPath, [SCRIPT, src], { stdio: 'pipe' })

    const manifestPath = join(src, 'pet.json')
    expect(existsSync(manifestPath)).toBe(true)
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))

    const parsed = parseGrowthManifest(raw)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // 6 阶段,SVG 文件都在源目录里(校验器只查字符串安全,不查存在)。
    expect(parsed.manifest.stages).toHaveLength(6)
    expect(parsed.manifest.stages[0]!.from).toBe(0)

    const imported = importGrowthPetPack(src, dest)
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.pet.growth?.stages).toHaveLength(6)
    // 每个阶段的图都真的落了盘。
    for (const stage of imported.pet.growth?.stages ?? []) {
      expect(existsSync(join(dest, stage.sheet))).toBe(true)
    }
  })
})
