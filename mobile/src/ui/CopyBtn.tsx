import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
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
    /**
     * ★★**可点区域靠 `padding` 撑,不能靠 `hitSlop`。**这一条是这颗按钮的全部要害,别「顺手简化」回去。
     *
     * 用户原话「对话的复制,好像不是真的复制啊,没有到粘贴板里啊」。剪贴板本身是好的 ——
     * 真机同级环境实测:`CAN_COPY=true`、`copyText()` 返回 true、`getStringAsync()` 读回来就是刚写进去
     * 那串,连 app 外面 `simctl pbpaste` 都拿得到。**写进去了,只是那一下点击根本没落到按钮上。**
     *
     * 原来这里写的是 `hitSlop={12}`,注释还写着「撑到手指够得着的大小」——**那 12pt 是死的**:
     *  - RN(Fabric)的命中测试在 `RCTViewComponentView.betterHitTest:`:
     *    `clipsToBounds = clipsToBounds || overflowInset == {}`,`if (clipsToBounds && !isPointInside) return nil`;
     *  - 而 `overflowInset` 由 `YogaLayoutableShadowNode::getContentBounds()` 算,取的是**子节点的 frame**,
     *    **hitSlop 不进这笔账**。
     *  - 三个调用处的祖先全是**紧贴着这颗按钮**的容器(`<View style={{marginLeft:'auto'}}>`、代码块头那一行、
     *    气泡下面那一条),它们的 overflowInset 因此是 0 ⇒ 「按钮外面那 12pt」在**祖先**那一层就被判在界外、
     *    直接 return nil,压根轮不到这颗 Pressable 的 hitSlop 说话。
     *  - 实测(iPhone 17 模拟器,`onLayout` 量的真数):整行 402×13、外层 22×13、**按钮自己 22×13**。
     *    苹果的最小可点是 44×44 —— 22×13 是它的七分之一,拇指在屏幕最右侧去点,点不中才是常态。
     *  ★同一颗 `hitSlop` 在 `chat.tsx` 的 ⤢ 上是**有效**的:那颗的祖先是整条输入区,又大又松,
     *   点在按钮外 8pt 仍落在祖先的 bounds 里,于是能一路下探到它。**hitSlop 只在祖先宽裕时才成立。**
     *
     * 所以改成自己带 `padding`:`padding` 会长进这颗 view 自己的 frame,祖先跟着被撑大,
     * 命中测试无论怎么走都绕不开它。代价是那一行会从 19pt 高到 33pt —— 值:一个点不中的按钮
     * 等于没有这个功能,而人还会以为是剪贴板坏了。
     * ★`hitSlop` 留 6:祖先宽裕的地方它是白捡的,祖先紧的地方它本来也不起作用,留着不会骗人。
     */
    <Pressable onPress={() => void press()} hitSlop={6} style={[st.hit, style]}>
      <T style={{ fontSize: 11, color: phase === 'fail' ? c.err : phase === 'ok' ? c.ok : c.faint }}>
        {phase === 'ok' ? '已复制' : phase === 'fail' ? '复制不了' : (label ?? '复制')}
      </T>
    </Pressable>
  )
}

const st = StyleSheet.create({
  /**
   * 44 宽 × 33 高(「复制」两个字的字形盒是 22×13,左右各 11、上下各 10)。
   * ★横向真的到了苹果要求的 44;纵向 33 是和「一条消息头才 19pt 高」之间的折中 ——
   *  再往上加,每条回复上面就顶着一条 44pt 的空带子,一屏看不了几句话。
   */
  hit: { paddingHorizontal: 11, paddingVertical: 10 },
})
