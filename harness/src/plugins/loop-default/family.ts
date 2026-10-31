// 模型族与工具集(spec §8.1、§7):族决定系统提示词与给模型哪几个工具
import type { ModelRequest, ModelsService } from '../../lib/models/types'
import type { Tool } from '../../lib/tools/types'
import type { ModelRef, Toolset } from '../../protocol/index'

export type Family = 'gpt' | 'claude' | 'generic'

/** 每个工具集给模型的工具,按这个顺序 */
export const TOOLSETS: Record<Toolset, readonly string[]> = {
  patch: ['read', 'list', 'glob', 'grep', 'apply_patch', 'shell'],
  edit: ['read', 'list', 'glob', 'grep', 'write', 'edit', 'shell'],
}

/**
 * 账号协议是 chatgpt → gpt;模型 id(去掉 `vendor/` 前缀)匹配 `^(gpt-|o\d|codex-)` → gpt,`^claude-` → claude;其余 generic
 */
export function family(protocol: string | undefined, modelId: string | undefined): Family {
  if (protocol === 'chatgpt') return 'gpt'
  const id = (modelId ?? '').split('/').at(-1)!.toLowerCase()
  if (/^(gpt-|o\d|codex-)/.test(id)) return 'gpt'
  if (/^claude-/.test(id)) return 'claude'
  return 'generic'
}

/** gpt → patch(apply_patch),其他 → edit(edit + write);会话的 toolset 优先 */
export function toolsetFor(f: Family, override?: Toolset): Toolset {
  return override ?? (f === 'gpt' ? 'patch' : 'edit')
}

/** 给模型的工具定义:唯一的映射处(按工具集顺序,缺的工具跳过) */
export function toolDefs(tools: Tool[], toolset: Toolset): NonNullable<ModelRequest['tools']> {
  const byName = new Map(tools.map(t => [t.name, t]))
  return TOOLSETS[toolset].flatMap(name => {
    const t = byName.get(name)
    return t ? [{ name: t.name, description: t.description, parameters: t.parameters }] : []
  })
}

/** 账号的协议:目录里只看得到预设;ChatGPT 订阅预设(chatgpt-oauth)固定走 chatgpt 协议 */
export function accountProtocol(models: Pick<ModelsService, 'catalog' | 'accounts'>, ref: ModelRef): string | undefined {
  const acc = models.accounts().find(a => a.id === ref.accountId)
  const preset = acc && models.catalog().presets.find(p => p.id === acc.presetId)
  if (!preset) return undefined
  return preset.auth === 'chatgpt-oauth' ? 'chatgpt' : preset.protocols[0]
}
