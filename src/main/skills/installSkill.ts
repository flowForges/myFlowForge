import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeTextAtomic } from '../util/atomicWrite'
import { FORGE_WORKFLOW_SKILL, workflowListSection } from './forgeWorkflowSkill'
import { readWorkspace } from '../config/store'

// Idempotently install the forge-workflow skill under <wsPath>/.claude/skills/. Safe to call on
// every chat turn: it only writes when the file is missing or its content has drifted from the
// current skill (so improving the skill auto-updates existing workspaces). Returns whether it
// wrote. The target lives in the workspace CONTAINER dir (which is not a git repo — the per-
// project worktrees are subdirs), so it never pollutes the user's repo or the changes pane.
// Content = base skill + this workspace's own "本工作区可选工作流" section (Task 8) so the claude
// main agent — which auto-discovers SKILL.md but never reads workspace.json — learns which
// workflowId to pass to forge_propose_plan instead of always falling back to ad-hoc stages.
export function ensureWorkspaceSkill(wsPath: string): boolean {
  const file = join(wsPath, FORGE_WORKFLOW_SKILL.relPath)
  const ws = readWorkspace(wsPath)
  const content = ws && ws.workflows.length > 0
    ? `${FORGE_WORKFLOW_SKILL.content}\n\n${workflowListSection(ws)}`
    : FORGE_WORKFLOW_SKILL.content
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false
  mkdirSync(dirname(file), { recursive: true })
  writeTextAtomic(file, content)
  return true
}
