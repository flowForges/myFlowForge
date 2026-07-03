import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { parseManifest } from './pluginManifest'

const ROOT = join(__dirname, '../../../resources/example-plugins')
const IDS = [
  'forge-example-claude-usage',
  'forge-example-codex-usage',
  'forge-example-gemini-usage',
]

describe('内置示例插件 fixtures', () => {
  for (const id of IDS) {
    it(`${id} manifest 合法且入口存在/可执行`, () => {
      const dir = join(ROOT, id)
      const r = parseManifest(dir)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.manifest.id).toBe(id)
      expect(r.manifest.type).toBe('statusbar-usage')
      const entry = join(dir, r.manifest.entry)
      expect(existsSync(entry)).toBe(true)
      // 可执行位（owner-exec）
      expect((statSync(entry).mode & 0o100) !== 0).toBe(true)
    })
  }
})
