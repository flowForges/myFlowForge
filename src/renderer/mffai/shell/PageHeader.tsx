import type { ReactNode } from 'react'
import type { MffaiPage } from '../route'

export const PAGE_TITLE: Record<MffaiPage, string> = { chat: '对话', tasks: '任务', memory: '记忆', plugins: '插件', conn: '连接', perm: '权限', debug: '调试' }

/** 每页顶部一条:标题 · 页面自己的块(HeaderExtra) · 弹簧 · 状态胶囊。slotRef 把挂载点交给外层的 HeaderSlotCtx */
export function PageHeader({ title, pill, slotRef }: { title: string; pill: ReactNode; slotRef?: (el: HTMLElement | null) => void }) {
  return (
    <header className="mffai-head">
      <h1 className="mffai-head-title">{title}</h1>
      <div className="mffai-head-slot" ref={slotRef} />
      <span className="mffai-head-spring" />
      {pill}
    </header>
  )
}
