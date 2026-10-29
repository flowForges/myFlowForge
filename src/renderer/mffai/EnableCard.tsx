export interface EnableCardProps {
  expectedRssMb: number
  dataDir: string
  autostart: boolean
  onToggleAutostart: (on: boolean) => void
  onEnable: () => void
}

export function EnableCard({ expectedRssMb, dataDir, autostart, onToggleAutostart, onEnable }: EnableCardProps) {
  return (
    <div className="mffai-card">
      <div className="mffai-row"><span className="mffai-k">常驻内存</span><span>约 {expectedRssMb} MB</span></div>
      <div className="mffai-row"><span className="mffai-k">数据目录</span><span className="mffai-path">{dataDir}</span></div>
      <label className="mffai-row">
        <span className="mffai-k">开机自启</span>
        <input type="checkbox" checked={autostart} onChange={e => onToggleAutostart(e.target.checked)} />
      </label>
      <button className="set-btn mffai-primary" onClick={onEnable}>启用</button>
    </div>
  )
}
