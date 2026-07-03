import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWorkspaceSkill } from './installSkill'
import { FORGE_WORKFLOW_SKILL } from './forgeWorkflowSkill'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'skill-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const skillFile = () => join(ws, FORGE_WORKFLOW_SKILL.relPath)

describe('ensureWorkspaceSkill', () => {
  it('writes the SKILL.md (mkdir -p) on first call and reports it wrote', () => {
    const wrote = ensureWorkspaceSkill(ws)
    expect(wrote).toBe(true)
    expect(existsSync(skillFile())).toBe(true)
    expect(readFileSync(skillFile(), 'utf8')).toBe(FORGE_WORKFLOW_SKILL.content)
  })

  it('is idempotent: a second call with identical content does not rewrite', () => {
    expect(ensureWorkspaceSkill(ws)).toBe(true)
    expect(ensureWorkspaceSkill(ws)).toBe(false)
  })

  it('rewrites when the on-disk content drifts from the current skill', () => {
    ensureWorkspaceSkill(ws)
    writeFileSync(skillFile(), 'STALE', 'utf8')
    expect(ensureWorkspaceSkill(ws)).toBe(true)
    expect(readFileSync(skillFile(), 'utf8')).toBe(FORGE_WORKFLOW_SKILL.content)
  })
})
