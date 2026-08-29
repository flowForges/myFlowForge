import { describe, it, expect } from 'vitest'
import { nextInputMode, nextInputState, tapPlusNeedsRefocus, type InputState, PANEL_H } from './inputPanel'

describe('输入区三态机', () => {
  it('点输入框 → 键盘', () => {
    expect(nextInputMode('idle', 'tapField')).toBe('keyboard')
    expect(nextInputMode('panel', 'tapField')).toBe('keyboard')
  })

  it('点 ＋ → 面板(微信:面板顶掉键盘,占它的位置)', () => {
    expect(nextInputMode('idle', 'tapPlus')).toBe('panel')
    expect(nextInputMode('keyboard', 'tapPlus')).toBe('panel')
  })

  it('面板开着再点 ＋ → 回到键盘(＋ 是个开关,不是单程票)', () => {
    expect(nextInputMode('panel', 'tapPlus')).toBe('keyboard')
  })

  it('★★收键盘这件事**不准**把面板一起关掉', () => {
    // 这是这个状态机存在的全部理由。打开面板的实现必然是「先 Keyboard.dismiss() 再显示面板」,
    // 而 dismiss 会立刻触发一次 keyboardHidden。要是那个事件把 mode 打回 idle,
    // 面板就在同一帧里被自己关掉了 —— 现象是「点 ＋ 没反应」,而且**看代码完全看不出来**。
    expect(nextInputMode('panel', 'keyboardHidden')).toBe('panel')
  })

  it('键盘自己被收起来(点了正文空白、按了系统收起)→ 什么都不开着', () => {
    expect(nextInputMode('keyboard', 'keyboardHidden')).toBe('idle')
    expect(nextInputMode('idle', 'keyboardHidden')).toBe('idle')
  })

  it('★键盘弹出来的时候面板必须让位 —— 两个一起显示会把输入框顶出屏幕', () => {
    expect(nextInputMode('panel', 'keyboardShown')).toBe('keyboard')
    expect(nextInputMode('idle', 'keyboardShown')).toBe('keyboard')
  })

  it('发出去之后保持原样 —— 连着发几条不该每条都要重新点开键盘', () => {
    expect(nextInputMode('keyboard', 'send')).toBe('keyboard')
    expect(nextInputMode('panel', 'send')).toBe('panel')
  })

  it('★离开这一屏一律清零', () => {
    expect(nextInputMode('panel', 'leave')).toBe('idle')
    expect(nextInputMode('keyboard', 'leave')).toBe('idle')
  })

  it('面板高度接近一块键盘 —— 太矮会在收键盘时露出一截正文再被盖住,画面抖一下', () => {
    expect(PANEL_H).toBeGreaterThan(220)
    expect(PANEL_H).toBeLessThan(320)
  })

  /**
   * ★★这条测的是「mode 变成 'keyboard' 这件事本身不会让键盘出现」这条**决定**——
   *  不是测键盘真的弹起来了(那是 `chat.tsx` 里 `fieldRef.current?.focus()` 的活,
   *  这个 node 环境的 vitest project 加载不动 `.tsx`,组件级别的这一半测不到,
   *  只能靠人真机点)。上面「面板开着再点 ＋ → 回到键盘」那条测的是 `nextInputMode` 的返回值,
   *  这条测的是**该不该采取行动**——两者看着像,但后者曾经是缺失的一环:
   *  mode 值算对了、真机上键盘照样不出来,这条测试就是为了让那个缺口有名字。
   */
  it('★★面板收回键盘(且只有这一种情况)需要手动重新 focus 输入框', () => {
    expect(tapPlusNeedsRefocus('panel')).toBe(true)
    expect(tapPlusNeedsRefocus('idle')).toBe(false)
    expect(tapPlusNeedsRefocus('keyboard')).toBe(false)
  })
})

describe('键盘事件的认领(设备级全局 Keyboard vs 这一屏自己的输入框)', () => {
  it('★★2026-08-29 复审抓到的洞:面板开着时,别的输入框(BigEditor/改名框…)自己弹起又收起的键盘,不准把面板关掉', () => {
    // 场景:点 ＋ 开了面板,面板里的「全屏编辑」打开一个带自己 Field 的编辑框——
    // 这个编辑框的 autoFocus 弹出键盘、关掉编辑框时它又收起键盘。这两次事件是全局广播的,
    // 但这一屏自己的输入框从头到尾没被碰过(keyboardOwner 仍是 null,没人认领)。
    let s: InputState = { mode: 'panel', keyboardOwner: null }
    s = nextInputState(s, 'keyboardShown') // 别的输入框弹起键盘
    expect(s.mode).toBe('panel')
    s = nextInputState(s, 'keyboardHidden') // 别的输入框收起键盘
    expect(s.mode).toBe('panel')
  })

  it('没认领的 keyboardShown 也不该把 idle 拽成 keyboard', () => {
    const s = nextInputState({ mode: 'idle', keyboardOwner: null }, 'keyboardShown')
    expect(s.mode).toBe('idle')
  })

  it('原有的 tapPlus → dismiss 序列必须还是原来那样:自己的输入框认领到的 keyboardHidden 照样不关面板', () => {
    let s: InputState = { mode: 'idle', keyboardOwner: null }
    s = nextInputState(s, 'tapField') // 用户点输入框
    expect(s).toEqual({ mode: 'keyboard', keyboardOwner: 'chat' })
    s = nextInputState(s, 'keyboardShown') // 真键盘弹起
    expect(s.mode).toBe('keyboard')
    s = nextInputState(s, 'tapPlus') // 用户点 ＋(真实组件里这一下之前会先 Keyboard.dismiss())
    expect(s.mode).toBe('panel')
    s = nextInputState(s, 'keyboardHidden') // dismiss 触发的那次 keyboardHidden 随后到达
    expect(s.mode).toBe('panel') // ★★没有被自己关掉
    expect(s.keyboardOwner).toBe(null) // 认领到的那次处理完就放手了
  })

  it('正常路数没坏:点输入框、弹键盘、点别处收起键盘 → 回到 idle', () => {
    let s: InputState = { mode: 'idle', keyboardOwner: null }
    s = nextInputState(s, 'tapField')
    s = nextInputState(s, 'keyboardShown')
    s = nextInputState(s, 'keyboardHidden') // 用户点了空白处,不是走 ＋
    expect(s.mode).toBe('idle')
  })

  it('离开这一屏连认领权一起清零', () => {
    const s = nextInputState({ mode: 'keyboard', keyboardOwner: 'chat' }, 'leave')
    expect(s).toEqual({ mode: 'idle', keyboardOwner: null })
  })

  // ── tapOutside(2026-08-29 真机第六轮)──────────────────────────────────────
  // 用户原话:「点 + 号后会打开面板,这时候正常交互是点击屏幕,这个输入框应该收起来,
  // 包括 + 也应该收起来,现在不是的,现在必须是再次点 + 才能收起来」。

  it('★面板开着时点对话流 → 面板收起', () => {
    const s = nextInputState({ mode: 'panel', keyboardOwner: null }, 'tapOutside')
    expect(s.mode).toBe('idle')
  })

  it('★tapOutside 连认领权一起放手 —— 否则收干净之后还攥着,别的弹层弹的键盘会被当成自己的', () => {
    const s = nextInputState({ mode: 'keyboard', keyboardOwner: 'chat' }, 'tapOutside')
    expect(s).toEqual({ mode: 'idle', keyboardOwner: null })
  })

  it('★收起之后紧跟着到达的 keyboardHidden 不会再把状态带跑(认领权已经放了)', () => {
    let s: InputState = { mode: 'panel', keyboardOwner: 'chat' }
    s = nextInputState(s, 'tapOutside')
    expect(s.mode).toBe('idle')
    s = nextInputState(s, 'keyboardHidden')
    expect(s).toEqual({ mode: 'idle', keyboardOwner: null })
  })

  it('tapOutside 之后点 ＋ 仍然开面板(状态机没被卡住)', () => {
    let s: InputState = { mode: 'panel', keyboardOwner: null }
    s = nextInputState(s, 'tapOutside')
    s = nextInputState(s, 'tapPlus')
    expect(s.mode).toBe('panel')
  })
})
