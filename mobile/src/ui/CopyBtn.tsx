import React, { useEffect, useRef, useState } from 'react'
import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { canCopy, copyText } from './copy'
import { useC } from '../theme/theme'
import { T } from './kit'

/**
 * ★这个探测在**模块作用域只跑一次**,一辈子不会变(装在这台手机上的那个包里有没有这个原生模块,
 *  是编译期就定死的事)。为假时调用方**根本不渲染那个入口** —— 不是灰的、不是点了弹一句,是没有。
 *  理由见 `copy.ts` 顶部:上一次「按钮照常显示、点下去当场崩」。
 *
 * ★为什么这颗按钮从 `app/chat.tsx` 搬到了单独一个文件:消息正文里的**每个代码块**现在也各配一颗
 *  (`MessageBody.tsx`),而 `MessageBody` 不能反过来 import 屏幕。复制成功的那点反馈(见下)
 *  抄成两份,迟早会一边说「已复制」一边什么都不说 —— 而「什么都不说」正是这颗按钮要治的病。
 */
export const CAN_COPY = canCopy()

/**
 * 复制一段文字。
 *
 * ★手机上**没有 toast**。复制成功却一点动静都没有,读起来就是「我点了,没反应」,然后人会再点三次
 *  还是不确定。所以反馈就在原地:那两个字自己变成「已复制」,1.5 秒后变回来。失败也要说
 *  (web 上明文 http 里根本没有 `navigator.clipboard`),别让人以为剪贴板里已经有东西了。
 */
export function CopyBtn({
  text,
  label,
  style,
}: {
  text: string
  /** 平时显示的字。默认「复制」;代码块那边用「⧉ 复制」,好和折叠箭头分开。 */
  label?: string
  style?: StyleProp<ViewStyle>
}) {
  const c = useC()
  const [phase, setPhase] = useState<'idle' | 'ok' | 'fail'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 复制完 1.5 秒才变回去,而这中间人完全可能已经退出这一屏 —— 定时器不清掉就是往已经卸载的组件上写。
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const press = async () => {
    const ok = await copyText(text)
    setPhase(ok ? 'ok' : 'fail')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPhase('idle'), 1500)
  }
  return (
    // hitSlop 撑到手指够得着的大小:这行字只有 11px,按原样大小是点不中的。
    <Pressable onPress={() => void press()} hitSlop={12} style={style}>
      <T style={{ fontSize: 11, color: phase === 'fail' ? c.err : phase === 'ok' ? c.ok : c.faint }}>
        {phase === 'ok' ? '已复制' : phase === 'fail' ? '复制不了' : (label ?? '复制')}
      </T>
    </Pressable>
  )
}
