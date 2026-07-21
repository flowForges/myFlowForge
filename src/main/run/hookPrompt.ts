import type { Plugin } from '../../shared/plugin'
import { skillDirective } from '../agents/pluginTools'
import type { HandoffBrief } from './runTypes'

/**
 * 交互铁律 —— 注入每个子代理(阶段 agent + 插件 hook)提示词。子代理常常"自觉"不去问用户就
 * 硬跑或假设,codex 更是除 forge_ask 外没有任何交互通道。此段强制:凡需用户确认/二选一/补充输入,
 * 必须调 forge_ask 并阻塞等待,拿到答复前不得假设/跳过/编造。这是唯一被支持的向用户提问方式。
 */
export const INTERACTION_DIRECTIVE = [
  '【交互指令】执行过程中,凡是需要用户确认、在多个选项间二选一、或补充你无法自行决定的信息时,',
  '你【必须】调用 forge_ask 工具把问题(有选项时一并给出选项)发给用户并阻塞等待答复;',
  '在拿到用户答复前,严禁自行假设、跳过、或编造答案。这是唯一被支持的向用户提问的方式。',
  '(You MUST call the forge_ask tool and block for the user\'s answer whenever you need',
  ' confirmation, a choice, or input you cannot decide yourself; never assume, skip, or fabricate.)',
].join('\n')

/**
 * Build the prompt for a workflow-scope plugin (hook micro-agent). The hook runs as a single
 * restricted sub-agent in the workspace root. Header = the requested skill directive (empty when
 * the plugin has no skills, so there's no directive noise); then the user task, the plugin step
 * name, the accumulated upstream briefs (so the hook can react to earlier stage/hook output), and
 * finally the plugin's own prompt.
 */
export function buildPluginPrompt(plugin: Plugin, briefs: HandoffBrief[], task?: string): string {
  const parts: string[] = []
  const dir = skillDirective(plugin.skills)
  if (dir) parts.push(dir.trim())
  parts.push(INTERACTION_DIRECTIVE)
  if (task) parts.push(`任务: ${task}`)
  parts.push(`插件步骤: ${plugin.name}`)
  if (briefs.length) {
    parts.push('上游产出:')
    for (const b of briefs) parts.push(`- [${b.agentName}] ${b.summary}` + (b.artifacts.length ? `（产物: ${b.artifacts.map(a => a.path).join(', ')}）` : ''))
  }
  parts.push('', plugin.prompt || '（无具体 prompt，作为占位步骤，简要说明已就绪即可。）')
  return parts.join('\n')
}
