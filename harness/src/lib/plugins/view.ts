// 钉住的插件视图(09 spec §9.3、M8):只读事件,和记忆的会话块同一条规则:日志里第一个算,所在的轮回滚了也算。
// 循环直接调,所以 plugin-manager 没激活、存储坏了,老会话的字节和工具都还在
import { PluginsInjectedPayloadSchema, type KernelEvent, type PluginsInjectedPayload } from '../../protocol/index'

export interface PluginView {
  skill: boolean
  mcp: boolean
}

function firstInjected(events: KernelEvent[]): PluginsInjectedPayload | undefined {
  for (const e of events) {
    if (e.type !== 'plugins.injected') continue
    const p = PluginsInjectedPayloadSchema.safeParse(e.payload)
    if (p.success) return p.data
  }
  return undefined
}

export function pluginViewOf(events: KernelEvent[]): PluginView | undefined {
  const p = firstInjected(events)
  return p && { skill: p.skill, mcp: p.mcp }
}

export function pluginBlockOf(events: KernelEvent[]): string | undefined {
  return firstInjected(events)?.text
}
