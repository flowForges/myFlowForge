// 页面往页头放自己的块(标题旁的数量、右侧的操作),不改数据流:页头登记一个挂载点,页面用 HeaderExtra 把子节点传送过去
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const HeaderSlotCtx = createContext<HTMLElement | null>(null)

export function HeaderExtra({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotCtx)
  return slot ? createPortal(children, slot) : null
}
