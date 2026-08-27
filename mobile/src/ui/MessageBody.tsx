import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { CAN_COPY, CopyBtn } from './CopyBtn'
import { splitHtmlChunks, type Chunk } from './htmlChunks'
import { splitCodeChunks, type CodeChunk } from './codeChunks'

/** 正文最终渲染成的三种块:代码 / 内嵌 HTML / 普通文字。 */
type Block = Chunk | Extract<CodeChunk, { kind: 'code' }>

/**
 * 代理正文的渲染。手机端只做一件事:**把内嵌 HTML 片段折起来**。
 *
 * 背景:桌面端有「对话区内嵌 HTML 可视化」(默认关),代理被告知复杂结构可以吐一小段自包含 HTML。
 * 那功能没开、或者手机端这边没实现时,这些 `<div style="…">` 会被**按原文打印**。
 * 27 寸屏上只是难看;390px 宽的手机上,一段卡片布局的 HTML 能吃掉四五屏,把真正的回答推到看不见的地方
 * —— 真机上第一次连上就撞见了。
 *
 * 为什么不干脆渲染出来:桌面那套是 `DOMParser` + 构造性白名单(绝不 innerHTML),而 React Native
 * 里没有 DOMParser。把它搬过来是另一个工程。**折叠是诚实的**:内容一个字没丢,点开就是原文,
 * 而且明说了「手机端不渲染」,不会让人以为自己看到的就是全部。
 */

/** 给折叠条一句人话的标题:说清是几行、大概是什么。 */
function describe(html: string): string {
  const lines = html.split('\n').length
  const tag = /^[ \t]*<([a-z]+)/i.exec(html)?.[1]?.toLowerCase() ?? '片段'
  const name = tag === 'table' ? '表格' : tag === 'svg' ? '图形' : tag === 'ul' || tag === 'ol' ? '列表' : '可视化片段'
  return `${name} · ${lines} 行 HTML`
}

function HtmlBlock({ html }: { html: string }) {
  const c = useC()
  const [open, setOpen] = useState(false)
  return (
    <View style={[st.box, { borderColor: c.border, backgroundColor: c.bg2 }]}>
      <Pressable onPress={() => setOpen((v) => !v)} style={st.head} hitSlop={4}>
        <T style={{ fontSize: 12.5, color: c.muted }}>
          {open ? '▾ ' : '▸ '}
          {describe(html)}
        </T>
        <T style={{ fontSize: 11, color: c.faint, marginLeft: 'auto' }}>手机端不渲染</T>
      </Pressable>
      {open ? (
        <T style={{ fontFamily: MONO, fontSize: 11, lineHeight: 17, color: c.fg2, padding: 10, paddingTop: 0 }}>
          {html}
        </T>
      ) : null}
    </View>
  )
}

/**
 * 一个 ``` 代码块 —— 电脑端 `views/chat/blocks.tsx` 的 `CodeBlock` 在手机上的样子。
 *
 * ★**每一块自己配一颗复制**,这是用户当场提的:整条消息一个复制按钮,拿回去的是一大坨掺着
 *  解说的文字,而人真正要粘出去的就是这一条命令。电脑端一样是按块配的(那边是 hover 显形,
 *  手机上没有 hover,所以常驻)。
 * ★代码**不换行**,改成横向滚动:命令和缩进一折行就读不出结构了(390pt 上一折就是三行)。
 *  代价是要横着划一下 —— 但复制按钮就在旁边,多数时候人根本不用划。
 * ★可折叠,和 `HtmlBlock` 同一个手势:一段两百行的代码会把回答本身推到看不见的地方。
 *  默认**展开** —— 折起来的代码是「藏起来的内容」,只有长到碍事时才该由人自己收。
 */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const c = useC()
  const [open, setOpen] = useState(true)
  const n = code.split('\n').length
  return (
    <View style={[st.box, { borderColor: c.border, backgroundColor: c.bg2 }]}>
      <View style={[st.head, open && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }]}>
        <Pressable
          onPress={() => setOpen((v) => !v)}
          hitSlop={6}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}
        >
          <T style={{ fontSize: 12.5, color: c.muted }}>{open ? '▾' : '▸'}</T>
          {lang ? (
            <T mono numberOfLines={1} style={{ fontSize: 10.5, letterSpacing: 0.4, color: c.faint }}>
              {lang}
            </T>
          ) : null}
          <T style={{ fontSize: 10.5, color: c.faint }}>{n} 行</T>
        </Pressable>
        {/* ★`CAN_COPY` 为假(旧包里没有 expo-clipboard)时整颗不摆 —— 同对话屏那两处的规矩。 */}
        {CAN_COPY ? (
          <View style={{ marginLeft: 'auto' }}>
            <CopyBtn text={code} label="⧉ 复制" />
          </View>
        ) : null}
      </View>
      {open ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.codeBody}>
          <T mono style={{ fontSize: 11.5, lineHeight: 18, color: c.fg2 }}>
            {code}
          </T>
        </ScrollView>
      ) : null}
    </View>
  )
}

export function MessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const c = useC()
  /**
   * ★**先切围栏、再在剩下的文字里找内嵌 HTML**,顺序不能反:HTML 那一支是按「行首是不是块级标签」
   *  判的,反过来的话 ```html 围栏里的 `<div>` 会被它整段折起来、还扣上「手机端不渲染」——
   *  那明明是一段要人读、要人复制的代码。
   * ★`useMemo`:流式吐字时这个组件每来一片就重渲染一次,两趟切块不该每帧都跑一遍。
   */
  const blocks = useMemo<Block[]>(
    () => splitCodeChunks(text).flatMap((ch): Block[] => (ch.kind === 'code' ? [ch] : splitHtmlChunks(ch.text))),
    [text],
  )
  return (
    <View style={{ paddingLeft: 26 }}>
      {blocks.map((ch, i) =>
        ch.kind === 'code' ? (
          <CodeBlock key={i} code={ch.text} lang={ch.lang} />
        ) : ch.kind === 'html' ? (
          <HtmlBlock key={i} html={ch.text} />
        ) : (
          <T key={i} style={{ fontSize: 15, lineHeight: 25, color: c.fg2 }}>
            {ch.text}
          </T>
        ),
      )}
      {streaming ? <T style={{ color: c.accent, fontSize: 15 }}>▍</T> : null}
    </View>
  )
}

const st = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, marginVertical: 6, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, paddingVertical: 9 },
  // 代码本体。`padding` 走 contentContainer 而不是 ScrollView 自己 —— 不然横向滚到底时右边那圈
  // 内边距会跟着滚走,最后一列字贴着边框。
  codeBody: { paddingHorizontal: 11, paddingTop: 8, paddingBottom: 10 },
})
