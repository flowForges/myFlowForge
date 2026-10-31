// 系统提示词(spec §8.2):每族 × 工具集一份固定文本,不放变量(利于缓存)
import type { Toolset } from '../../../protocol/index'
import type { Family } from '../family'
import { CLAUDE_NOTES } from './claude'
import { EDIT_TOOLS, IDENTITY, PATCH_TOOLS, READ_TOOLS, SAFETY, STYLE, WORKFLOW } from './common'
import { GENERIC_NOTES } from './generic'
import { GPT_NOTES } from './gpt'

export { environmentBlock, type EnvironmentInfo } from './environment'

const NOTES: Record<Family, string> = { gpt: GPT_NOTES, claude: CLAUDE_NOTES, generic: GENERIC_NOTES }
const EDITING: Record<Toolset, string> = { patch: PATCH_TOOLS, edit: EDIT_TOOLS }

/** 会话的工具集可以覆盖族的默认,所以提示词按两者一起定;同一会话内恒定 */
export function systemPrompt(family: Family, toolset: Toolset): string {
  return [IDENTITY, WORKFLOW, NOTES[family], `# Tools\n${READ_TOOLS}\n${EDITING[toolset]}`, SAFETY, STYLE].join('\n\n')
}
