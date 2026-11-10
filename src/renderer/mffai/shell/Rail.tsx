import type { ReactNode } from 'react'
import { MFFAI_PAGES, type MffaiPage } from '../route'
import type { NavCounts } from '../useShellInfo'
import { Icon, type IconName } from './icons'
import { PAGE_TITLE } from './PageHeader'

const NAV_ICON: Record<MffaiPage, IconName> = { chat: 'chat', tasks: 'tasks', memory: 'brain', plugins: 'puzzle', conn: 'link', perm: 'shield', debug: 'bug' }
/** 徽标色:对话、记忆是提醒(warn),插件是出了问题(err) */
const BADGE_TONE: Partial<Record<MffaiPage, 'warn' | 'err'>> = { chat: 'warn', memory: 'warn', plugins: 'err' }

/** 左侧图标轨:logo · 7 项导航(调试贴底) · 电源位(在 nav 外)。数字:没有就不显示 */
export function Rail({ page, counts, disabled, onSelect, power }: { page: MffaiPage; counts: NavCounts; disabled?: boolean; onSelect(p: MffaiPage): void; power: ReactNode }) {
  return (
    <aside className="mffai-rail">
      <span className="mffai-logo"><Icon name="sparkle" size={16} /></span>
      <nav className="mffai-nav">
        {MFFAI_PAGES.map((p) => (
          <button key={p} className={`${p === page ? 'on ' : ''}${p === 'debug' ? 'end' : ''}`.trim() || undefined} disabled={disabled} onClick={() => onSelect(p)}>
            <Icon name={NAV_ICON[p]} size={20} />
            <span className="mffai-navlabel">{PAGE_TITLE[p]}</span>
            {!!counts[p] && <span className={`mffai-navnum ${BADGE_TONE[p] ?? 'warn'}`}>{counts[p]}</span>}
          </button>
        ))}
      </nav>
      {power}
    </aside>
  )
}
