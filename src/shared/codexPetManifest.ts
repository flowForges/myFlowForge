export interface CodexManifest {
  id: string
  displayName: string
  description?: string
  spriteVersionNumber: number
  spritesheetPath: string
}

// Validate a parsed pet.json against the Codex v2 contract. Pure: the caller does the file read.
export function parseCodexManifest(raw: unknown): { ok: true; manifest: CodexManifest } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'pet.json 不是对象' }
  const o = raw as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).length ? (o[k] as string) : undefined)
  const id = str('id'); const displayName = str('displayName'); const spritesheetPath = str('spritesheetPath')
  if (!id) return { ok: false, error: 'pet.json 缺少 id' }
  if (!displayName) return { ok: false, error: 'pet.json 缺少 displayName' }
  if (!spritesheetPath) return { ok: false, error: 'pet.json 缺少 spritesheetPath' }
  if (o.spriteVersionNumber !== 2) return { ok: false, error: '仅支持 spriteVersionNumber: 2 的 Codex 宠物' }
  const description = str('description')
  return {
    ok: true,
    manifest: description === undefined
      ? { id, displayName, spriteVersionNumber: 2, spritesheetPath }
      : { id, displayName, description, spriteVersionNumber: 2, spritesheetPath },
  }
}
