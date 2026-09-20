import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import type { ToolActivity } from '../../../src/shared/types'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { BODY_LINE_CAP, parseToolBody, statusMark, toolHead, type ToolBody } from './toolParse'

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

export function ToolCard({ tool, fetchOutput }: { tool: ToolActivity; fetchOutput?: FetchOutput }) {
  const c = useC()
  const [open, setOpen] = useState(false)
  /**
   * 按需取回来的输出。
   *
   * ★★历史里大于 1KB 的工具输出**整段没下发**(`toolOutputCap.ts` 的 `omitOver`)——
   *  这一屏的卡默认全是折叠的,而一条消息能有 54 次调用,全下发等于「下载下来只为了藏起来」。
   *  实测最大会话 389KB → 85KB。所以真正点开的那一条,到这里才去取。
   * ★只取一次:取到就存在这儿,反复折叠展开不会反复发请求。
   */
  const [lazy, setLazy] = useState<{ output: string; outputLines?: number } | null>(null)
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState<string | null>(null)

  const shown = lazy?.output ?? tool.output
  const shownLines = lazy?.outputLines ?? tool.outputLines
  /** 有输出、但还没下载 —— 和「这个工具压根没回传输出」是两回事,屏幕上也得是两句话。 */
  const pending = !!tool.outputOmitted && !lazy

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (!next || !pending || fetching || !fetchOutput) return
    setFetching(true)
    setFetchErr(null)
    void fetchOutput(tool.id)
      .then((r) => setLazy(r))
      .catch((e) => setFetchErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setFetching(false))
  }

  // ★`outputLines` = 服务端截断前的原始行数。传下去,「还有 N 行没显示」才是真数字。
  const body = useMemo(
    () => (shown ? parseToolBody(shown, BODY_LINE_CAP, shownLines) : null),
    [shown, shownLines],
  )
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
      <Pressable onPress={toggle} style={st.th} hitSlop={4}>
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
        {/* ★这次调用被「完全访问」自动放行了。电脑端同一枚标记(`views/chat/ToolBlock.tsx`)——
            它以前是对话流里一条独立消息,长得和模型的回答一样,现在归位到它真正属于的这一行。
            ★手机上更要克制:一屏本来就窄,一轮十几次调用,写成句子会把工具卡挤没。 */}
        {tool.autoAllowed ? (
          <T
            accessibilityLabel="已按「完全访问」自动放行"
            style={[st.auto, { color: c.faint }]}
          >
            🛡
          </T>
        ) : null}
        {mark ? <T style={[st.mark, { color: tool.status === 'error' ? c.err : c.ok }]}>{mark}</T> : null}
      </Pressable>
      {open ? (
        body ? (
          <CodeBody body={body} />
        ) : (
          <T style={[st.none, { color: c.faint, borderTopColor: c.border, backgroundColor: c.bg2 }]}>
            {/* ★★四句话对应四种**不同**的情况。合并任何两句都是在说一件不成立的事:
                「没回传输出」和「还没下载」在屏幕上长得一样的话,人会以为这条命令没输出。 */}
            {fetchErr
              ? `输出没取到:${fetchErr}`
              : fetching
                ? '正在取这一条的输出…'
                : pending
                  ? `${shownLines ? `共 ${shownLines} 行,` : ''}点开时才下载(还没连上?)`
                  : running
                    ? '还在跑,输出要等它结束'
                    : '这个工具没有回传输出'}
          </T>
        )
      ) : null}
    </View>
  )
}

/**
 * 按 `toolId` 取回这一条的完整输出。由上层(chat 屏)绑好 workspace/session/message 再传下来 ——
 * 卡片自己不该知道自己长在哪条消息上。
 */
export type FetchOutput = (toolId: string) => Promise<{ output: string; outputLines?: number }>

/** 一条回复这一轮自己跑过的所有工具。空数组不占位。 */
export function ToolCards({ tools, fetchOutput }: { tools?: ToolActivity[]; fetchOutput?: FetchOutput }) {
  if (!tools?.length) return null
  return (
    <View style={{ gap: 6, marginBottom: 6 }}>
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} fetchOutput={fetchOutput} />
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
  // 比状态标记还淡:它是背景信息,不是这一行的重点。
  auto: { fontSize: 10.5, opacity: 0.55, marginLeft: 2 },
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
