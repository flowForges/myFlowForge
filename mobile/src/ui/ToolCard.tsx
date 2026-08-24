import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import type { ToolActivity } from '../../../src/shared/types'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { parseToolBody, statusMark, toolHead, type ToolBody } from './toolParse'

/**
 * 工具卡 —— 原型 `d.css` 的 `.tool` / `.tool .th` / `.code`。
 *
 * 为什么非做不可:手机端在这之前**完全看不见代理在调工具**。它读文件、改文件、跑命令的那十几秒里,
 * 屏幕上只有一段思考,然后正文突然蹦出来 —— 看起来像卡住了。桌面端一直有完整的「执行」块。
 * 而且原型 D 的两个招牌特性之一就是「工具调用就地展开」(`directions.html`:「拿走 B 的门钉法
 * + C 的工具调用就地展开」),这一条一直是缺的。
 *
 * ★缩进跟着代理气泡走(`paddingLeft: 26` 的那一栏)——它是挂在**那条回复**下面的一步,
 *  不是一条独立的消息。原型里 `.tool` 就是 `margin-left: 26px; width: calc(100% - 26px)`。
 *
 * ★内容一个字都不编。provider 没给 output(codex 的 `编辑文件` 就不给)就只画标题行,
 *  展开也只说「这个工具没有输出」。解析规则见 `toolCard.ts`。
 */

function CodeBody({ body }: { body: ToolBody }) {
  const c = useC()
  const showLn = body.kind === 'numbered'
  return (
    <View style={[st.code, { borderTopColor: c.border, backgroundColor: c.bg2 }]}>
      {/* 代码横着放不下就横向滚,不折行 —— 折了行的 diff 比看不见还难读。 */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: '100%' }}>
        <View>
          {body.lines.map((l, i) => (
            <View
              key={i}
              style={[
                st.cl,
                l.kind === 'add' ? { backgroundColor: c.addBg } : l.kind === 'del' ? { backgroundColor: c.delBg } : null,
              ]}
            >
              {showLn ? <T style={[st.ln, { color: c.faint }]}>{l.ln}</T> : null}
              {/* 行号列本身就是左边那 40px 的槽;没有它的时候要自己补一点左边距,不然贴着边框。 */}
              <T style={[st.tx, !showLn && { paddingLeft: 11 }, { color: c.fg2 }]}>{l.text || ' '}</T>
            </View>
          ))}
        </View>
      </ScrollView>
      {/* ★截断必须说出来。静默截断会让人以为「它就跑出这么点东西」。 */}
      {body.dropped > 0 ? (
        <T style={[st.more, { color: c.faint }]}>
          只显示前 {body.lines.length} 行,还有 {body.dropped} 行没显示(共 {body.total} 行)
        </T>
      ) : null}
    </View>
  )
}

export function ToolCard({ tool }: { tool: ToolActivity }) {
  const c = useC()
  const [open, setOpen] = useState(false)
  const body = useMemo(() => (tool.output ? parseToolBody(tool.output) : null), [tool.output])
  const head = useMemo(() => toolHead(tool, body), [tool, body])
  const mark = statusMark(tool.status)
  const running = tool.status === 'run'

  return (
    <View
      style={[
        st.tool,
        { backgroundColor: c.surface, borderColor: running ? c.toolRunBorder : c.border },
      ]}
    >
      <Pressable onPress={() => setOpen((v) => !v)} style={st.th} hitSlop={4}>
        <T style={[st.cv, { color: c.muted }]}>{open ? '▾' : '▸'}</T>
        <T style={[st.k, { color: c.fg2 }]}>{head.verb}</T>
        <T numberOfLines={1} style={[st.p, { color: c.muted }]}>
          {head.target}
        </T>
        {head.stat ? (
          head.add != null && head.del != null ? (
            <T style={st.s}>
              <T style={{ color: c.add, fontFamily: MONO, fontSize: 11.5 }}>+{head.add}</T>
              <T style={{ color: c.del, fontFamily: MONO, fontSize: 11.5 }}> −{head.del}</T>
            </T>
          ) : (
            <T style={[st.s, { color: c.muted }]}>{head.stat}</T>
          )
        ) : null}
        {mark ? <T style={[st.mark, { color: tool.status === 'error' ? c.err : c.ok }]}>{mark}</T> : null}
      </Pressable>
      {open ? (
        body ? (
          <CodeBody body={body} />
        ) : (
          <T style={[st.none, { color: c.faint, borderTopColor: c.border, backgroundColor: c.bg2 }]}>
            {running ? '还在跑,输出要等它结束' : '这个工具没有回传输出'}
          </T>
        )
      ) : null}
    </View>
  )
}

/** 一条回复这一轮自己跑过的所有工具。空数组不占位。 */
export function ToolCards({ tools }: { tools?: ToolActivity[] }) {
  if (!tools?.length) return null
  return (
    <View style={{ gap: 6, marginBottom: 6 }}>
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
    </View>
  )
}

const st = StyleSheet.create({
  // .tool { width: calc(100% - 26px); margin-left: 26px; border-radius: 11px; overflow: hidden }
  tool: { marginLeft: 26, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  // .tool .th { display:flex; gap:9px; padding:9px 11px; font: mono 11.5 }
  th: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 11, paddingVertical: 9 },
  cv: { fontSize: 11, width: 11 },
  k: { fontFamily: MONO, fontSize: 11.5, fontWeight: '600' },
  p: { fontFamily: MONO, fontSize: 11.5, flex: 1, minWidth: 0 },
  s: { fontFamily: MONO, fontSize: 11.5 },
  mark: { fontSize: 11.5, fontWeight: '700' },
  // .code { font: mono 11.5 / 1.8; padding: 8px 0 }  ·  .tool .code { border-top; background: --bg-2 }
  code: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 8 },
  cl: { flexDirection: 'row' },
  // .code .ln { width: 40px; text-align: right; padding-right: 9px }
  ln: { width: 40, textAlign: 'right', paddingRight: 9, fontFamily: MONO, fontSize: 11.5, lineHeight: 21 },
  // .code .tx { padding-right: 11px }
  tx: { fontFamily: MONO, fontSize: 11.5, lineHeight: 21, paddingRight: 11 },
  more: { fontSize: 11, paddingHorizontal: 11, paddingTop: 6 },
  none: { fontSize: 11.5, paddingHorizontal: 11, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth },
})
