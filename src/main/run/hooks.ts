import type { Plugin } from '../../shared/plugin'
import type { ArtifactRef } from './runTypes'
import { skillDirective } from '../agents/pluginTools'

// ③stage hooks (run2): the workflow-scope hooks woven between stages during a run. Migrated from the
// legacy orchestrator (pluginWeave.ts / runHook / buildPluginPrompt), kept run2-owned so deleting the
// orchestrator later doesn't touch run2. A hook (Plugin) carries `after`: '__start' (before the first
// stage), a stage key (right after that stage advances forward), or '__wf' (after the whole run
// finishes). It runs as a RESTRICTED micro-agent at the workspace root (limited to its own skills/
// tools). NOTE: the build-workspace step hooks ('__basic'/'__proj') are a SEPARATE system (stepHooks.
// ts) run at workspace-creation time — deliberately NOT handled here.

/**
 * The run's hooks, assembled from a workspace's two plugin arrays: `plugins` (workflow-scope, woven by
 * `after` = '__start' or a stage key) plus only the `after === '__wf'` members of `stepPlugins` (the
 * run-end step hooks). Everything else in stepPlugins ('__basic'/'__proj') is build-time and dropped.
 * Pure — takes the arrays, not the Workspace, to stay decoupled from the config schema.
 */
export function collectRunHooks(plugins: Plugin[] = [], stepPlugins: Plugin[] = []): Plugin[] {
  return [...plugins, ...stepPlugins.filter((p) => p.after === '__wf')]
}

/** The hooks that fire at a given weave point (`after` key): '__start', a stage key, or '__wf'. */
export function hooksAfter(hooks: Plugin[] | undefined, afterKey: string): Plugin[] {
  return (hooks ?? []).filter((h) => h.after === afterKey)
}

/** A hook lane's id / stage key — namespaced so it never collides with a real stage key. */
export function hookLaneId(pluginId: string): string { return `hook:${pluginId}` }

/**
 * The prompt for a hook micro-agent: its skill directive (so it loads+follows the chosen skills) + a
 * short role framing + the run's task + the upstream artifacts produced so far + the hook's own prompt.
 * Decoupled run2 analogue of the orchestrator's buildPluginPrompt (which read HandoffBrief); here the
 * upstream context is the run's ArtifactRef list, matching what RunController.buildPrompt already
 * threads to every stage.
 */
export function buildHookPrompt(plugin: Plugin, upstream: ArtifactRef[], task?: string): string {
  const parts: string[] = []
  const dir = skillDirective(plugin.skills)
  if (dir) parts.push(dir.trim())
  parts.push('你是本工作流里的一个 hook 微步骤。只做本步骤该做的事，完成后用一句话说明你做了什么。')
  parts.push('若卡在只有人类才知道的硬阻塞（缺凭据、连哪个环境、用哪个 key 等），调用 forge_ask 直接问用户，不要瞎猜。')
  if (task) parts.push(`【任务】${task}`)
  parts.push(`【hook 步骤】${plugin.name}`)
  if (upstream.length) {
    parts.push('【上游产物】')
    for (const a of upstream) parts.push(`- ${a.path} (${a.kind})`)
  }
  parts.push('', plugin.prompt || '（无具体 prompt，作为占位步骤，简要说明已就绪即可。）')
  return parts.join('\n')
}
