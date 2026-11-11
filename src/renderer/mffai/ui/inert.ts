// 模态打开时把 mff-ai 整个视图里它以外的东西设成 inert:从 el 往上到 .mffai-page(没有就 body),每一层的兄弟都设,
// 所以 rail、页头、左列、对话列都进去;之后才出现的兄弟由 MutationObserver 补上。keep 里的元素(比如抽屉自己的遮罩)不设。
// 只动自己设的,卸载时还原。首装整页(A)、升级弹窗(B)、添加账号抽屉、活动抽屉共用。
import { useEffect, type RefObject } from 'react'

export function useInertOutside(ref: RefObject<HTMLElement | null>, on = true, keep: RefObject<Element | null>[] = []) {
  useEffect(() => {
    const el = ref.current
    if (!on || !el) return
    const root = el.closest('.mffai-page') ?? document.body
    const set = new Set<Element>()
    const parents: Element[] = []
    for (let node: Element = el; node !== root && node.parentElement; node = node.parentElement) parents.push(node.parentElement)
    const apply = () => {
      for (let node: Element = el; node !== root && node.parentElement; node = node.parentElement) {
        for (const sib of node.parentElement.children) {
          if (sib === node || set.has(sib) || sib.hasAttribute('inert') || keep.some((k) => k.current === sib)) continue
          sib.setAttribute('inert', '')
          set.add(sib)
        }
      }
    }
    apply()
    const mo = new MutationObserver(apply)
    for (const p of parents) mo.observe(p, { childList: true })
    return () => { mo.disconnect(); for (const s of set) s.removeAttribute('inert') }
  }, [ref, on]) // eslint-disable-line react-hooks/exhaustive-deps
}
