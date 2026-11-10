// 会话头(08b §4.3):标题、运行中、目录、审批模式、弹簧、「活动」开关(按下 = 面板展开;数字 = 这个会话待批的审批,收起时照样显示)。
// 窄窗(主区 < 1200)只留标题、运行中、目录:其余块挂 mffai-nhide,用 CSS 藏,DOM 里还在。
import { Chip } from '../ui/Chip'
import { Icon } from '../shell/icons'

export const ACT_PANEL_ID = 'mffai-act'

export function ChatHeader({ title, running, parked, cwd, mode, pending, panelOn, narrow, onToggle }: {
  title: string
  running: boolean
  /** 开着的那一轮挂起了:挂起 块代替 运行中 */
  parked?: boolean
  cwd?: string
  mode: 'ask' | 'auto'
  pending: number
  panelOn: boolean
  narrow?: boolean
  onToggle(): void
}) {
  return (
    <header className="mffai-chathead">
      <span className="mffai-chathead-title" title={title}>{title}</span>
      {parked ? <Chip tone="warn" dot>挂起</Chip> : running && <Chip tone="run" dot>运行中</Chip>}
      {cwd && <span className="mffai-chathead-cwd" title={cwd}><Icon name="folder" size={12} />{cwd}</span>}
      <span className={`mffai-chathead-mode${narrow ? ' mffai-nhide' : ''}`}>
        {mode === 'auto' ? <Chip tone="warn">自动放行</Chip> : <Chip tone="line">询问</Chip>}
      </span>
      <span className="mffai-spring" />
      <button type="button" className={`set-btn mffai-actbtn${panelOn ? ' on' : ''}`} aria-expanded={panelOn}
        aria-controls={ACT_PANEL_ID} onClick={onToggle}>
        <Icon name="sidebar" size={14} />活动
        {pending > 0 && <span className="n">{pending}</span>}
      </button>
    </header>
  )
}
