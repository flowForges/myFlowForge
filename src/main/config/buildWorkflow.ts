import { type Workflow, type StageConfig } from './schema'
import { deriveProjectId } from './projectId'

// A stage to seed into a new workflow: either a bare key (built-in defaults) or a full StageConfig
// (custom stage with name/prompt/flags). Order is preserved as given — the caller controls it.
export type StageSeed = string | StageConfig

function toStageConfig(s: StageSeed): StageConfig {
  if (typeof s === 'string') return { key: s, defaultAgent: 'claude', defaultModel: 'opus-4.8' }
  return { ...s, defaultAgent: s.defaultAgent || 'claude', defaultModel: s.defaultModel || 'opus-4.8' }
}

export function buildWorkflow(name: string, stages: StageSeed[], existingIds: string[]): Workflow {
  const base = deriveProjectId(name) || 'workflow'
  let id = base
  let n = 2
  while (existingIds.includes(id)) { id = `${base}-${n++}` }
  // Preserve the given order + dedupe by key (a workflow can't have two stages with the same key).
  const seen = new Set<string>()
  const built = stages.map(toStageConfig).filter(s => (seen.has(s.key) ? false : (seen.add(s.key), true)))
  return { id, name: name.trim(), stages: built, plugins: [], stagePrompts: {} }
}
