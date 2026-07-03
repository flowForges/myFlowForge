import { STAGE_KEYS, type Workflow } from './schema'
import { deriveProjectId } from './projectId'

export function buildWorkflow(name: string, stageKeys: string[], existingIds: string[]): Workflow {
  const base = deriveProjectId(name) || 'workflow'
  let id = base
  let n = 2
  while (existingIds.includes(id)) { id = `${base}-${n++}` }
  const stages = STAGE_KEYS
    .filter(k => stageKeys.includes(k))
    .map(k => ({ key: k, defaultAgent: 'claude', defaultModel: 'opus-4.8' }))
  return { id, name: name.trim(), stages, plugins: [], stagePrompts: {} }
}
