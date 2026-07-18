import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureWorkspaceSkill, removeWorkspaceSkill } from './installSkill'
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

describe('removeWorkspaceSkill', () => {
  it('removes the forge-workflow skill dir and returns true, leaving a sibling skill untouched', () => {
    ensureWorkspaceSkill(ws)   // installs .claude/skills/forge-workflow/SKILL.md
    const forgeSkillDir = dirname(skillFile())
    const siblingFile = join(ws, '.claude/skills/other-skill/SKILL.md')
    mkdirSync(dirname(siblingFile), { recursive: true })
    writeFileSync(siblingFile, 'other skill content', 'utf8')

    expect(removeWorkspaceSkill(ws)).toBe(true)
    expect(existsSync(forgeSkillDir)).toBe(false)
    expect(existsSync(siblingFile)).toBe(true)
  })

  it('returns false and does not throw when the skill was never installed', () => {
    expect(existsSync(dirname(skillFile()))).toBe(false)
    expect(() => removeWorkspaceSkill(ws)).not.toThrow()
    expect(removeWorkspaceSkill(ws)).toBe(false)
  })
})
