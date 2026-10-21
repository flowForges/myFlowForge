import type { ReactNode } from 'react'
import { AGENT_LOGO_SVG } from './agentLogos'

/**
 * 某个编码代理的图标:有官方 SVG 就用 SVG,没有就退回调用方给的字符(catalog glyph / 首字母)。
 * ★SVG 是仓库里写死的常量(agentLogos.ts),不是外部输入,所以直接塞 innerHTML。
 */
export function agentIcon(id: string, fallback: ReactNode): ReactNode {
  const svg = AGENT_LOGO_SVG[id]
  return svg ? <span className="ag-svg" data-agent-logo={id} dangerouslySetInnerHTML={{ __html: svg }} /> : fallback
}
