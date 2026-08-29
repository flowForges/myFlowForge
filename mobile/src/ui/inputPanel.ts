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
 * ★★2026-08-29 复审抓到的洞:`nextInputMode('panel', 'tapPlus')` 算出 `'keyboard'`,但那只是
 *  一个字符串 —— 屏幕上**没有任何东西**会因为这个值变了就真的弹出键盘。面板卸载是「收起了什么」,
 *  不是「唤起了什么」;要让键盘真的回来,必须有人拿着 `Field` 的 ref 手动 `.focus()`
 *  (见 `app/chat.tsx` ＋ 那颗键的 onPress)。这个函数就是那颗「该不该去 focus()」的开关,
 *  判据从 `nextInputMode` 本身**推导**出来,不是重复抄一份 `mode === 'panel'` —— `nextInputMode`
 *  的 `tapPlus` 分支以后要是改了(比如面板加了第三态),这里跟着改,不用两处一起记。
 *
 * ★这颗函数只回答「该不该」,真正调 `.focus()` 的是 `chat.tsx`(只有它有 ref)——
 *  那一步是 RN 组件行为,这个 node 环境的 vitest project 加载不动 `.tsx`,测不到。
 *  见 `inputPanel.test.ts` 里这条测试上面的说明。
 */
export function tapPlusNeedsRefocus(modeBefore: InputMode): boolean {
  return modeBefore === 'panel' && nextInputMode(modeBefore, 'tapPlus') === 'keyboard'
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

/**
 * 谁「认领」了下一次真正到达的 keyboardHidden。
 *
 * ★★2026-08-29 复审抓到:`Keyboard` 是**设备级全局**的,不是这一屏自己的。上面那台状态机
 *  原来对每一次 `keyboardShown`/`keyboardHidden` 都无条件当真,隐含的假设是「设备上任何时候
 *  弹起/收起的键盘都是这一屏自己的输入框弹的」—— 只要屏幕上还有**别的**输入框,这条假设就不成立。
 *  复现路径:点 ＋ 开面板 → 点面板里的「全屏编辑」→ 那个编辑框自己 `autoFocus` 弹出键盘 →
 *  关掉编辑框、它的键盘收起 → 这两次事件全局广播,原来的写法照单全收,面板在用户**既没碰 ＋
 *  也没碰输入框**的情况下被自己关掉了。跟 ★★ 那条「dismiss 触发的 keyboardHidden 不准关面板」
 *  是**同一类**问题的第二个入口:上一次挡的是「自己的 dismiss」,这一次要挡的是「别人的键盘」。
 *
 *  修法不是给 BigEditor 或以后的改名框(见 Task 8/9)各开一个特例 —— 那样每加一个带 Field
 *  的弹层就得回来再补一次,而且没人会想到要补。真正要变的是那条隐含假设本身:
 *  一次键盘事件**只有在这一屏自己的输入框认领着的时候才作数**,没认领的一律原样吃掉、
 *  `mode` 一个字都不碰。认领规则只有两条,谁的输入框都不需要知道这件事:
 *   - 这一屏自己的 `Field` 拿到焦点(`tapField`)→ 认领。
 *   - 处理完一次**真正认领到的** `keyboardHidden` → 放手。
 *  ★★不在失焦时放手:点 ＋ 会先 `Keyboard.dismiss()` 让输入框失焦,再 `fire('tapPlus')` ——
 *  状态机要的正是紧随失焦之后那次 `keyboardHidden` 事件被正确认领、走到下面 `mode === 'panel'`
 *  那条 ★★ 分支。失焦和「这次收起事件该不该处理」是两件事,前者不该提前交出认领权。
 */
export type KeyboardOwner = 'chat' | null

export interface InputState {
  mode: InputMode
  keyboardOwner: KeyboardOwner
}

export const initialInputState: InputState = { mode: 'idle', keyboardOwner: null }

/**
 * 和 `nextInputMode` 是同一件事,多带了一层「这次键盘事件是不是我们认领的」。
 * ★`mode` 的转移规则完全委托给 `nextInputMode`(那份已经有单测 + 变异测试钉住,原样复用,
 *  不重复一份逻辑),这里只加认领/放手这一层闸门。
 */
export function nextInputState(state: InputState, ev: InputEvent): InputState {
  const { mode, keyboardOwner } = state
  if (ev === 'keyboardShown' || ev === 'keyboardHidden') {
    // ★★没认领 = 这次键盘事件是别的输入框弹的/收的,跟这一屏的状态机没关系,原样吃掉。
    if (keyboardOwner !== 'chat') return state
    return {
      mode: nextInputMode(mode, ev),
      // 认领到的 keyboardHidden 处理完就放手;keyboardShown 不改变认领状态。
      keyboardOwner: ev === 'keyboardHidden' ? null : keyboardOwner,
    }
  }
  return {
    mode: nextInputMode(mode, ev),
    keyboardOwner: ev === 'tapField' ? 'chat' : ev === 'leave' ? null : keyboardOwner,
  }
}
