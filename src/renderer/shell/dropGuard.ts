/**
 * 窗口级的拖放兜底。
 *
 * ★★往 Electron 窗口里拖一个文件,**默认行为是把整个窗口导航到那个 `file://` 地址** —— 一次拖歪
 *  就是白屏,而且没有地址栏可以退回来,只能重启 app。输入框接住了它自己那一块,可这一块只占屏幕
 *  的一小条:「拖拽附件」一上线,用户就会开始试着拖,拖偏是常态而不是意外。所以这层兜底是**必需品**。
 *
 * ★只管**文件**拖拽(`types` 里有 'Files')。把一段文字拖进 textarea 是浏览器的原生能力,
 *  在这里一并拦掉等于顺手弄坏一个好功能。
 *
 * ★落在输入框以外时把 `dropEffect` 设成 'none',光标显示「不能放」—— 拦住导航之后如果还显示
 *  「可以放」,用户会以为哪儿都能扔,扔完却什么都没发生,那是更难受的一种坏。输入框自己会
 *  `stopPropagation`,所以它那一块的 'copy' 不会被这里改掉。
 *
 * 装法与 installAutoHideScrollbars 一致:main.tsx 里装一次,覆盖全窗口,组件不用各自登记。
 */
export function installDropGuard(target: Window = window): () => void {
  const isFileDrag = (e: Event) => {
    const dt = (e as DragEvent).dataTransfer
    return !!dt && Array.from(dt.types ?? []).includes('Files')
  }
  const block = (e: Event) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    const dt = (e as DragEvent).dataTransfer
    if (dt) { try { dt.dropEffect = 'none' } catch { /* 只读的 dataTransfer(某些合成事件) */ } }
  }
  target.addEventListener('dragover', block)
  target.addEventListener('drop', block)
  return () => {
    target.removeEventListener('dragover', block)
    target.removeEventListener('drop', block)
  }
}
