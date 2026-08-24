import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { splitHtmlChunks } from './htmlChunks'

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

export function MessageBody({ text, streaming }: { text: string; streaming?: boolean }) {
  const c = useC()
  const chunks = splitHtmlChunks(text)
  return (
    <View style={{ paddingLeft: 26 }}>
      {chunks.map((ch, i) =>
        ch.kind === 'html' ? (
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
})
