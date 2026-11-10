import { useState } from 'react'
import type { MffaiState } from '@mffai/protocol'
import { Confirm } from './ui/Confirm'
import { CodeChip } from './ui/CodeChip'
import { Icon, type IconName } from './shell/icons'

export type WipeOutcome = { ok: boolean; removed?: string[]; reason?: string }

export interface EnableCardProps {
  expectedRssMb: number
  dataDir: string
  autostart: boolean
  onToggleAutostart: (on: boolean) => void
  onEnable: () => void
  failed?: boolean
  /** 停用后数据还在:出 `删除全部数据` */
  dataExists?: boolean
  /** 主进程算好的根目录和钥匙串条目(R14:渲染层不算) */
  roots?: MffaiState['roots']
  onWipe?: () => Promise<WipeOutcome>
}

// 都是事实,不写"需要你去做什么"(08 §12.5、R7)
const FEATURES: readonly (readonly [IconName, string])[] = [['chat', '对话'], ['term', '委派 CLI'], ['brain', '记忆'], ['send', 'Telegram'], ['puzzle', '插件']]
const KEEP = ['仓库里的 refs/mffai 快照引用', '仓库里的 worktree 登记', 'Telegram 机器人令牌'] as const

export function EnableCard({ expectedRssMb, dataDir, autostart, onToggleAutostart, onEnable, failed, dataExists, roots, onWipe }: EnableCardProps) {
  const [confirming, setConfirming] = useState(false)
  const [wiping, setWiping] = useState(false)
  const [wipeFail, setWipeFail] = useState<string | null>(null)
  const wipe = () => {
    if (!onWipe) return
    setWiping(true)
    setWipeFail(null)
    void onWipe()
      .then((r) => { if (r.ok) setConfirming(false); else { setWipeFail(r.reason ?? 'failed'); setConfirming(false) } })
      .catch((e) => { console.error('mffai wipe', e); setWipeFail('failed'); setConfirming(false) })
      .finally(() => setWiping(false))
  }
  return (
    <div className="mffai-hero">
      <span className="mffai-herologo"><Icon name="sparkle" size={28} /></span>
      <div className="mffai-herotitle">mff-ai</div>
      <div className="mffai-feats">
        {FEATURES.map(([i, t]) => <div key={t} className="mffai-feat"><span className="mffai-feattile"><Icon name={i} size={18} /></span><span>{t}</span></div>)}
      </div>
      <div className="mffai-card">
        <div className="mffai-row"><span className="mffai-k">常驻内存</span><span className="mffai-mono">约 {expectedRssMb} MB</span></div>
        <div className="mffai-row">
          <span className="mffai-k">数据目录</span>
          <span className="mffai-path">{dataDir}</span>
          <button type="button" className="set-btn mffai-iconbtn" aria-label="复制" onClick={() => { void navigator.clipboard?.writeText(dataDir) }}><Icon name="copy" size={12} /></button>
        </div>
        <label className="mffai-switch mffai-row">
          <span className="mffai-k">开机自启</span>
          <input type="checkbox" checked={autostart} onChange={e => onToggleAutostart(e.target.checked)} />
        </label>
      </div>
      <button className="set-btn mffai-primary mffai-enable" onClick={onEnable}><Icon name="power" size={16} />启用</button>
      {dataExists && roots && onWipe && (
        <button className="set-btn mffai-danger mffai-wipe" disabled={wiping} onClick={() => { setWipeFail(null); setConfirming(true) }}><Icon name="trash" size={13} />删除全部数据</button>
      )}
      {failed && <span className="mffai-fail">失败</span>}
      {wipeFail && <span className="mffai-actions"><span className="mffai-fail">失败</span><CodeChip code={wipeFail} /></span>}
      {confirming && roots && (
        <Confirm
          title="删除全部数据"
          rows={[
            ['数据目录', roots.data],
            ['委派 worktree', roots.worktrees],
            ['IM worktree', roots.imWorktrees],
            ['插件代码', roots.plugins],
            ['钥匙串条目', roots.keychain],
            ...(roots.launchAgent ? [['LaunchAgent', roots.launchAgent] as const] : []),
          ]}
          keep={KEEP}
          confirmLabel="删除全部数据"
          danger
          busy={wiping}
          onCancel={() => setConfirming(false)}
          onConfirm={wipe}
        />
      )}
    </div>
  )
}
