// src/renderer/views/InstallBanner.tsx
import { useCallback, useEffect, useState } from 'react'
import type { ProviderInfo } from '@shared/types'

export function InstallBanner({ onGoSettings }: { onGoSettings: () => void }) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null)
  const reload = useCallback(() => { void window.forge.detectProviders().then((p: ProviderInfo[]) => setProviders(p)) }, [])
  useEffect(() => { reload() }, [reload])
  if (!providers) return null
  const builtins = providers.filter(p => !p.custom)
  if (builtins.length === 0 || builtins.some(p => p.installed)) return null
  return (
    <div className="install-banner">
      <div className="ib-head">
        <div className="ib-title">本机未检测到任何编码代理</div>
        <div className="ib-sub">先安装并登录至少一个 CLI(Claude Code / Codex / Gemini 等),才能创建工作区与发起会话。</div>
      </div>
      <div className="ib-cmds">
        {builtins.filter(p => p.installCmd).map(p => (
          <div className="ib-cmd" key={p.id}>
            <span className="ib-cmd-name">{p.displayName}</span>
            <code>{p.installCmd}</code>
            <CopyBtn text={p.installCmd!} />
          </div>
        ))}
      </div>
      <div className="ib-actions">
        <button className="ib-btn" onClick={reload}>重新检测</button>
        <button className="ib-btn primary" onClick={onGoSettings}>去设置</button>
      </div>
    </div>
  )
}
// Shared with QuickStart (first-run guide): one-shot "复制/已复制" clipboard button.
export function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return <button className={`cli-copy${done ? ' done' : ''}`} onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1300) }}>{done ? '已复制' : '复制'}</button>
}
