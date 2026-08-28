/**
 * 输入区底下那块地方,同一时刻只能是三种之一:什么都没有 / 键盘 / ＋ 面板。
 *
 * ★★为什么要把它抠成一个状态机:微信式的 ＋ 面板是**顶掉键盘、占它的位置**的
 *  (所以面板不吃正文高度)。实现上必然是「先 `Keyboard.dismiss()`,再显示面板」——
 *  而 dismiss 会**立刻**触发一次 keyboardHidden 事件。要是那个事件无条件把状态打回
 *  「什么都没有」,面板就在同一帧里被自己关掉了。现象是「点 ＋ 没反应」,
 *  而且**盯着代码看是看不出来的**(两处都各自正确,错的是它们的先后)。
 *  抠出来之后这条就是一行断言(见 inputPanel.test.ts 那条带 ★★ 的)。
 *
 * ★零 RN import,能在 node 那套 vitest 里被直接测。
 */

export type InputMode = 'idle' | 'keyboard' | 'panel'

export type InputEvent =
  /** 点了输入框 */
  | 'tapField'
  /** 点了 ＋ */
  | 'tapPlus'
  /** 系统报:键盘出来了 */
  | 'keyboardShown'
  /** 系统报:键盘收了 */
  | 'keyboardHidden'
  /** 发出去了一条 */
  | 'send'
  /** 离开这一屏 */
  | 'leave'

export function nextInputMode(mode: InputMode, ev: InputEvent): InputMode {
  switch (ev) {
    case 'tapField':
      return 'keyboard'
    // ＋ 是个**开关**:面板没开就开、开着就收回键盘。单程票的话人得去点输入框才关得掉。
    case 'tapPlus':
      return mode === 'panel' ? 'keyboard' : 'panel'
    // 键盘和面板不能同时在 —— 两个一起显示会把输入框顶出屏幕。
    case 'keyboardShown':
      return 'keyboard'
    // ★★面板开着的时候,收键盘是**打开面板的必经步骤**,不是「用户想关掉一切」。见上面那段。
    case 'keyboardHidden':
      return mode === 'panel' ? 'panel' : 'idle'
    case 'send':
      return mode
    case 'leave':
      return 'idle'
  }
}

/**
 * ＋ 面板的高度。
 *
 * ★写死而不是去记「上一次键盘多高」:键盘高度随输入法、随是否有候选栏、随横竖屏变,
 *  记它就得处理「还没弹过键盘所以不知道多高」那一档 —— 而那正是冷启动第一次点 ＋ 的情况。
 *  一个固定值在所有情况下都稳定,代价是和某些输入法差个十几 pt,而面板下方就是安全区,
 *  差这一点看不出来。
 */
export const PANEL_H = 268
