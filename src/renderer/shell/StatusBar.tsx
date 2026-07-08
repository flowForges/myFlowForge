import './shell.css'
import './logcon.css'
import type { ReactNode } from 'react'
import type { ProviderInfo } from '@shared/types'
import type { StatusbarUsage } from '@shared/plugins'
import { getBuiltinProvider } from '@shared/providerCatalog'
import { UsagePopover } from './UsagePopover'

// SVG icon overrides for the 5 built-in providers — geometric originals tracking each vendor's
// official mark (Anthropic starburst / OpenAI knot / Gemini sparkle / Cursor prism), drawn with
// currentColor so the tile's `color` tints them. Verbatim from the prototype's BRAND_SVG.
// Brand colors (bg/color) are now sourced from the shared providerCatalog.
// Only these 5 providers have custom SVG; any other installed provider falls back to glyph or first letter.
const SVG_OVERRIDE: Record<string, ReactNode> = {
  claude: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round"><path d="M12 3v18M3 12h18M5.64 5.64l12.72 12.72M18.36 5.64L5.64 18.36" /></svg>,
  codex: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><path d="M12 4.2c2.2-1.6 5.2-.4 5.6 2.3 2.7.4 3.9 3.4 2.3 5.6 1.6 2.2.4 5.2-2.3 5.6-.4 2.7-3.4 3.9-5.6 2.3-2.2 1.6-5.2.4-5.6-2.3-2.7-.4-3.9-3.4-2.3-5.6C2.5 9.9 3.7 6.9 6.4 6.5 6.8 3.8 9.8 2.6 12 4.2Z" /><circle cx="12" cy="12" r="2.7" /></svg>,
  gemini: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.55 5.2 2.8 7.45 8 8-5.2.55-7.45 2.8-8 8-.55-5.2-2.8-7.45-8-8 5.2-.55 7.45-2.8 8-8Z" /></svg>,
  qoder: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M15.5 15.5 19 19" /></svg>,
  cursor: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round"><path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7z" /><path d="M12 2.6V21.4M3.6 7l8.4 5 8.4-5" /></svg>,
}

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

export interface StatusBarProps {
  branch: string
  providers: ProviderInfo[]
  sbLog?: SbLogProps
  sbTerm?: SbTermProps
  usageByProvider?: Record<string, StatusbarUsage>
  update?: {
    currentVersion: string
    hasUpdate: boolean
    updateVersion?: string
    checking: boolean
    uptodate: boolean
    checkFailed: boolean
    onCheck: () => void
    onOpenUpgrade: () => void
  }
}

export function StatusBar({ branch, providers, sbLog, sbTerm, usageByProvider, update }: StatusBarProps) {
  return (
    <div className="statusbar">
      {/* Model indicators — only providers actually detected on this machine */}
      <div className="sb-models">
        {providers.filter(p => p.installed).map(p => {
          const meta = getBuiltinProvider(p.id)
          const bg = meta?.brandBg ?? 'var(--surface)'
          const color = meta?.brandColor ?? 'var(--fg-2)'
          const icon = SVG_OVERRIDE[p.id] ?? meta?.glyph ?? p.displayName.slice(0, 1).toUpperCase()
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
        {/* Terminal toggle button — first child of .sb-right per prototype */}
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

        {/* Only show the git-branch chip when there actually is a branch — non-git workspaces left it
            showing an empty/dash slot. */}
        {branch && branch.trim() && (
          <span className="it">
            {/* git-branch icon */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            {branch}
          </span>
        )}
        {update && (
          <span
            className={'it sb-ver' + (update.checkFailed ? ' failed' : '')}
            title={update.checkFailed ? '检查更新失败:无法连接 GitHub(可在设置里配置代理),点击重试' : '点击检查更新'}
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
