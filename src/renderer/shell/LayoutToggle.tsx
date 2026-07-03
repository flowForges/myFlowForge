import type { DockLayout } from '../state/panelDock'

/** Stack(上下) ⇄ Split(左右) toggle — a floating pill on the panel seam, shown only when both
 *  panels are open (visibility handled in CSS via .panel-dock.both-open). */
export function LayoutToggle({ layout, onToggle }: { layout: DockLayout; onToggle: () => void }) {
  const split = layout === 'split'
  return (
    <button
      className={`panel-layout-toggle${split ? ' on' : ''}`}
      onClick={onToggle}
      title={split ? '面板布局:左右并排,点击切回上下' : '面板布局:上下堆叠,点击切到左右'}
      aria-label="切换实时日志和终端布局"
    >
      {split ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="5" width="7" height="14" rx="1.5" />
          <rect x="13" y="5" width="7" height="14" rx="1.5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="5" width="16" height="6" rx="1.5" />
          <rect x="4" y="13" width="16" height="6" rx="1.5" />
        </svg>
      )}
      {split ? '左右' : '上下'}
    </button>
  )
}
