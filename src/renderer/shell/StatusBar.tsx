import './shell.css'
import './logcon.css'
import type { ProviderInfo } from '@shared/types'
import type { StatusbarUsage } from '@shared/plugins'
import { getBuiltinProvider } from '@shared/providerCatalog'
import { UsagePopover } from './UsagePopover'
import { agentIcon } from '../components/AgentLogo'
import { HostSwitcher } from './HostSwitcher'
import type { HostDisplay } from '@shared/remote/hostView'

export interface SbLogProps {
  open: boolean
  live: boolean
  has: boolean
  onToggle: () => void
}

export interface SbTermProps {
  open: boolean
  onToggle: () => void
}

export interface SbHostProps {
  /** 这枚按钮显示成什么样。★是**按钮**的设置,不是某台主机的 —— 切主机不改变它。 */
  display: HostDisplay
  onOpenHosts: () => void
}

export interface StatusBarProps {
  providers: ProviderInfo[]
  sbLog?: SbLogProps
  sbTerm?: SbTermProps
  sbHost?: SbHostProps
  usageByProvider?: Record<string, StatusbarUsage>
  update?: {
    currentVersion: string
    hasUpdate: boolean
    updateVersion?: string
    checking: boolean
    uptodate: boolean
    checkFailed: boolean
    checkError?: string | null
    onCheck: () => void
    onOpenUpgrade: () => void
  }
}

export function StatusBar({ providers, sbLog, sbTerm, sbHost, usageByProvider, update }: StatusBarProps) {
  return (
    <div className="statusbar">
      {/* Model indicators — only providers actually detected on this machine */}
      <div className="sb-models">
        {providers.filter(p => p.installed).map(p => {
          const meta = getBuiltinProvider(p.id)
          const bg = meta?.brandBg ?? 'var(--surface)'
          const color = meta?.brandColor ?? 'var(--fg-2)'
          const icon = agentIcon(p.id, meta?.glyph ?? p.displayName.slice(0, 1).toUpperCase())
          const usage = usageByProvider?.[p.id]
          const pillContent = (
            <>
              <span className="d" />
              <span className="mc-logo-sm" style={{ background: bg, color, fontWeight: 700 }}>
                {icon}
              </span>
              {p.displayName}
            </>
          )
          return usage
            ? (
              <UsagePopover key={p.id} usage={usage}>
                <button className="sb-model">{pillContent}</button>
              </UsagePopover>
            )
            : (
              <button key={p.id} className="sb-model">
                {pillContent}
              </button>
            )
        })}
      </div>

      {/* Right side: log button + branch + context */}
      <div className="sb-right">
        {/* ★主机排在最左 —— 它是「这些东西属于哪台机器」,统辖右边所有的东西(终端开在哪台、
            日志是谁的、版本是谁的)。读的顺序就是包含关系的顺序。 */}
        {sbHost && <HostSwitcher display={sbHost.display} onOpenHosts={sbHost.onOpenHosts} />}
        {/* Terminal toggle button */}
        {sbTerm && (
          <button className={`sb-log${sbTerm.open ? ' on' : ''}`} title="终端 (⌃`)" onClick={sbTerm.onToggle}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 9 12 4 17"/><line x1="12" y1="17" x2="20" y2="17"/></svg>
            终端
          </button>
        )}
        {/* Live log toggle button */}
        {sbLog && (
          <button
            className={`sb-log${sbLog.live ? ' live' : ''}${sbLog.has ? ' has' : ''}${sbLog.open ? ' on' : ''}`}
            title="实时日志"
            onClick={sbLog.onToggle}
          >
            <span className="lg-dot" />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="4 7 9 12 4 17" />
              <line x1="12" y1="17" x2="20" y2="17" />
            </svg>
            实时日志
          </button>
        )}

        {update && (
          <span
            className={'it sb-ver' + (update.checkFailed ? ' failed' : '')}
            title={update.checkFailed ? `检查更新失败:无法连接 GitHub(可在设置里配置代理),点击重试${update.checkError ? `\n原因:${update.checkError}` : ''}` : '点击检查更新'}
            onClick={update.onCheck}
          >
            {update.checking ? '检查中…'
              : update.checkFailed ? '检查失败'
              : update.uptodate ? '已是最新'
              : `Forge v${update.currentVersion}`}
          </span>
        )}
        {update?.hasUpdate && (
          <span className="sb-update show" onClick={update.onOpenUpgrade}>
            <span className="dot" />新版本 v{update.updateVersion}
          </span>
        )}
      </div>
    </div>
  )
}
