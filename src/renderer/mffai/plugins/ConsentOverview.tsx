// 首装同意页的四块概览(08b spec 06-consent-A):会启动几个服务、可联网 已勾 / 建议、不会运行几项、警告几个。
// 数字全从 PluginConsent 和当前授权算,不加数据。
import type { PluginConsent } from '@mffai/protocol'
import { Icon, type IconName } from '../shell/icons'

/** 不会运行的条目数:每个 hook、每个列表项、每个远程 MCP、main */
export function notRunCount(c: PluginConsent): number {
  const nr = c.notRun
  return nr.hooks.length + nr.agents.length + nr.bin.length + nr.monitors.length + nr.workflows.length
    + nr.lsp.length + nr.other.length + nr.scripts.length + nr.remoteMcp.length + (nr.main !== undefined ? 1 : 0)
}

/** 授权编辑器里每个服务列出的域名(建议的 ∪ 声明的),按服务各算一次 */
export function suggestedCount(c: PluginConsent): number {
  return c.mcp.reduce((n, m) => n + new Set([...m.suggestedHosts, ...(m.declared?.network ?? [])]).size, 0)
}

export function ConsentOverview({ consent: c, checkedHosts }: { consent: PluginConsent; checkedHosts: number }) {
  const tiles: [IconName, string, string, string][] = [
    ['server', '会启动', `${c.mcp.filter((m) => m.problems.length === 0).length} 个服务`, 'acc'],
    ['globe', '可联网', `${checkedHosts} / ${suggestedCount(c)} 已勾`, ''],
    ['ban', '不会运行', `${notRunCount(c)} 项`, ''],
    ['alert', '警告', String(c.warnings.length), c.warnings.length > 0 ? 'warn' : ''],
  ]
  return (
    <div className="mffai-cov">
      {tiles.map(([icon, k, v, tone]) => (
        <div key={k} className={`mffai-covt ${tone}`}>
          <span className="mffai-covi"><Icon name={icon} size={14} /></span>
          <span className="mffai-covk">{k}</span>
          <span className="mffai-covv">{v}</span>
        </div>
      ))}
    </div>
  )
}
