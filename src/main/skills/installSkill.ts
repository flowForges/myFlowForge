import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeTextAtomic } from '../util/atomicWrite'
import { FORGE_WORKFLOW_SKILL } from './forgeWorkflowSkill'

// Idempotently install the forge-workflow skill under <wsPath>/.claude/skills/. Safe to call on
// every chat turn: it only writes when the file is missing or its content has drifted from the
// current skill (so improving the skill auto-updates existing workspaces). Returns whether it
// wrote. The target lives in the workspace CONTAINER dir (which is not a git repo — the per-
// project worktrees are subdirs), so it never pollutes the user's repo or the changes pane.
export function ensureWorkspaceSkill(wsPath: string): boolean {
  const file = join(wsPath, FORGE_WORKFLOW_SKILL.relPath)
  if (existsSync(file) && readFileSync(file, 'utf8') === FORGE_WORKFLOW_SKILL.content) return false
  mkdirSync(dirname(file), { recursive: true })
  writeTextAtomic(file, FORGE_WORKFLOW_SKILL.content)
  return true
}
