import { describe, it, expect, beforeEach } from 'vitest'
import { installDropGuard } from './dropGuard'

/**
 * 往窗口里拖文件,Electron 的默认行为是**把整个窗口导航到那个 file:// 地址** —— 一次拖歪就是白屏,
 * 而且回不来(没有地址栏)。所以「拖拽附件」这个功能一旦上线,窗口级的兜底就是必需品,不是锦上添花:
 * 用户会开始试着拖,拖偏一点点就把 app 弄没了。
 *
 * ★只拦**文件**拖拽。把一段文字拖进 textarea 是浏览器的原生能力,拦了就等于顺手弄坏一个好功能。
 */
const dragEvent = (type: string, types: string[]) => {
  const e = new Event(type, { bubbles: true, cancelable: true })
  const dt = { types, dropEffect: 'copy' }
  Object.defineProperty(e, 'dataTransfer', { value: dt })
  return { e, dt }
}

let off: () => void
beforeEach(() => { off?.(); off = installDropGuard() })

describe('窗口级拖放兜底', () => {
  it('★★拖文件进来必须 preventDefault —— 不拦就是整窗导航到 file://,白屏', () => {
    for (const type of ['dragover', 'drop']) {
      const { e } = dragEvent(type, ['Files'])
      window.dispatchEvent(e)
      expect(e.defaultPrevented, type).toBe(true)
    }
  })

  it('落在输入框以外的地方,光标显示「不能放」而不是骗人的「可以放」', () => {
    const { e, dt } = dragEvent('dragover', ['Files'])
    window.dispatchEvent(e)
    expect(dt.dropEffect).toBe('none')
  })

  it('★拖文字不管 —— 把一段文字拖进输入框是原生能力,拦了就是白弄坏一个好功能', () => {
    const { e } = dragEvent('dragover', ['text/plain'])
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })

  it('卸载之后不再插手', () => {
    off()
    off = () => {}
    const { e } = dragEvent('drop', ['Files'])
    window.dispatchEvent(e)
    expect(e.defaultPrevented).toBe(false)
  })
})
