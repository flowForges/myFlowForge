/**
 * 滚动条自动隐藏（用户实测 2026-08-18）。
 *
 * global.css 里那条 `::-webkit-scrollbar-thumb` 是全局的:凡内容溢出的容器都常驻画一条 10px 滑块。
 * 侧栏会话列表一长,那条深色竖条就永远贴在侧栏右缘 —— 正好压在刚调细的分栏接缝旁边,比接缝本身还显眼。
 *
 * 期望行为是 macOS 那种 overlay 滚动条:平时不见,鼠标进到那一栏才显示,滚动时显示,停下几秒后淡出。
 * 前两条纯 CSS 能做(`:hover`),第三条做不到 —— CSS 没有"滚动停止"这个状态,只能靠计时器。所以这里
 * 只补那一件事:滚动时给【真正滚动的那个元素】挂上 data-scrolling,空闲 IDLE_MS 后摘掉,显隐规则仍然
 * 全部写在 global.css 里。
 *
 * 用一个 document 上的捕获监听覆盖全部滚动容器,而不是每个面板各自接一遍:scroll 事件不冒泡,但【会捕获】,
 * 所以捕获阶段挂一个就能收到任意深度容器的滚动。新增可滚动面板时不需要记得来这里登记。
 */

/** 停止滚动多久后隐藏。macOS 自身约 1s;取 1.2s 略宽松一点,避免滚一下停一下时闪烁。 */
export const IDLE_MS = 1200

/** 每个滚动容器各自的隐藏计时器。WeakMap:元素卸载后条目自动回收,不用手动清理。 */
const timers = new WeakMap<Element, number>()

function markScrolling(el: Element, idleMs: number): void {
  el.setAttribute('data-scrolling', '')
  const prev = timers.get(el)
  if (prev !== undefined) window.clearTimeout(prev)
  timers.set(
    el,
    window.setTimeout(() => {
      // 只摘属性,不管鼠标在不在上面 —— 悬停时是否继续显示由 global.css 的 :hover 那条说了算,
      // 两个条件各管各的,这里不去猜另一个。
      el.removeAttribute('data-scrolling')
      timers.delete(el)
    }, idleMs),
  )
}

/**
 * 装上全局监听。返回卸载函数(测试用;生产里跟着窗口一起走,不需要卸)。
 * `capture: true` 是必须的 —— scroll 不冒泡。`passive: true` 因为我们从不 preventDefault。
 */
export function installAutoHideScrollbars(
  target: Document | HTMLElement = document,
  idleMs: number = IDLE_MS,
): () => void {
  const onScroll = (e: Event): void => {
    // 滚动 document 时 target 是 Document 本身,它没有 setAttribute —— 交给 documentElement。
    const el = e.target instanceof Element ? e.target : document.documentElement
    markScrolling(el, idleMs)
  }
  target.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => target.removeEventListener('scroll', onScroll, { capture: true })
}
