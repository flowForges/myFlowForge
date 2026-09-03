import { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { MONO, useC } from '../theme/theme'
import { T } from './kit'
import { CAN_COPY, CopyBtn } from './CopyBtn'
import { splitHtmlChunks, type Chunk } from './htmlChunks'
import { splitCodeChunks, type CodeChunk } from './codeChunks'
import { HIGHLIGHT_MAX, highlightBlock } from '@shared/highlight'
import { synStyle } from './synStyle'
import { htmlFallbackNote, parseHtmlSubset } from './htmlParse'
import { parseMarkdown } from './mdParse'
import { HtmlRender } from './HtmlRender'

/** 正文最终渲染成的三种块:代码 / 内嵌 HTML / 普通文字。 */
type Block = Chunk | Extract<CodeChunk, { kind: 'code' }>

/**
 * 代理正文的渲染。内嵌 HTML 片段走**两条路**:能忠实画的就画,画不了的折起来。
 *
 * 背景:桌面端有「对话区内嵌 HTML 可视化」,代理被告知复杂结构可以吐一小段自包含 HTML。
 * 手机端一开始一律折叠 + 标「手机端不渲染」—— 诚实,但用户原话是「html不渲染」,他要的是看见。
 * 他同时否掉了 WebView(不想再多一个原生依赖),所以现在的做法是:
 *  ① `parseHtmlSubset`(零 import 的纯解析,`htmlParse.ts`)先判这段能不能**忠实**画出来;
 *  ② 能 → `HtmlRender` 用纯 RN 原语画(表格 / 列表 / 标题 / 粗斜体 / 链接 / 代码 / 段落);
 *  ③ 不能(带任意 CSS、未知标签、嵌套太深、标签没闭合)→ **原样退回底下这个折叠占位**。
 *
 * ★③ 不是「还没做完」,是设计。画出半个表格、丢掉一半单元格,而人以为自己看到的就是全部 ——
 *  那比不画危险得多。折叠占位内容一个字没丢,点开就是原文,而且明说了「手机端不渲染」。
 */

/** 给折叠条一句人话的标题:说清是几行、大概是什么。 */
function describe(html: string): string {
  const lines = html.split('\n').length
  const tag = /^[ \t]*<([a-z]+)/i.exec(html)?.[1]?.toLowerCase() ?? '片段'
  const name = tag === 'table' ? '表格' : tag === 'svg' ? '图形' : tag === 'ul' || tag === 'ol' ? '列表' : '可视化片段'
  return `${name} · ${lines} 行 HTML`
}

/**
 * 一段内嵌 HTML。先试着真画,画不忠实就退回折叠占位。
 *
 * ★`useMemo`:流式吐字时整条消息每来一片就重渲染一次,而这段片段在闭合之前每一帧都是
 *  「没闭合 → 退回占位」。解析本身不贵,但没必要每帧重跑一遍。
 */
function HtmlBlock({ html }: { html: string }) {
  const parsed = useMemo(() => parseHtmlSubset(html), [html])
  if (parsed.ok) return <HtmlRender nodes={parsed.nodes} />
  return <HtmlFallback html={html} note={htmlFallbackNote(parsed.reason)} />
}

/**
 * 一段 markdown 正文。
 *
 * ★`useMemo`:流式吐字时整条消息每来一片就重渲染一次,而**每一片都会让这一段的文本变长** ——
 *  不缓存的话每帧都要把整段重新解析一遍,越到后面越贵(和上面 `HtmlBlock` 同一条理由)。
 */
function MdBlock({ text }: { text: string }) {
  const nodes = useMemo(() => parseMarkdown(text), [text])
  return <HtmlRender nodes={nodes} />
}

/**
 * 画不了时的折叠占位 —— 手机端一期就是这个,原样留着,它是「诚实」那一半。
 *
 * ★`note` 是**那一关的名字**,不再是一句笼统的「手机端不渲染」。后者在流式吐字的时候
 *  是**假话**(片段只是还没闭合),用户为此报过一次「看的时候不渲染,退出重进又有了」。
 */
function HtmlFallback({ html, note }: { html: string; note: string }) {
  const c = useC()
  const [open, setOpen] = useState(false)
  return (
    <View style={[st.box, { borderColor: c.border, backgroundColor: c.bg2 }]}>
      <Pressable onPress={() => setOpen((v) => !v)} style={st.head} hitSlop={4}>
        <T style={{ fontSize: 12.5, color: c.muted }}>
          {open ? '▾ ' : '▸ '}
          {describe(html)}
        </T>
        <T style={{ fontSize: 11, color: c.faint, marginLeft: 'auto' }}>{note}</T>
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
  /**
   * ★语法着色。用户原话:「像各种格式的文件,应该支持不同的渲染,比如编程语言渲染」。
   *  走的是 `@shared/highlight` 的**整块**入口,和电脑端 `views/chat/blocks.tsx` 的 `CodeBlock`
   *  同一份语法表 —— 整块那条路才认得跨行的块注释和多行字符串(逐行的那条看不到上下文,
   *  会把 `/*` 之后的半个块漏掉)。
   * ★`highlightBlock` 自己会在**没写语言**时原样返回不着色:那种块多半是日志 / 纯文本输出,
   *  乱上色反而干扰。超过 `HIGHLIGHT_MAX` 也一样退回 —— 一个几万字符的块切成上万个 `<Text>`,
   *  在 RN 里就是一次几秒的卡顿。
   * ★`useMemo`:流式吐字时这个组件每来一片就重渲染一次,分词不该每帧重跑。
   */
  const toks = useMemo(() => {
    if (!lang.trim() || code.length > HIGHLIGHT_MAX) return null
    const out = highlightBlock(code, lang)
    // 全是无色 token 的话不如整块一个 `<T>`:少几百个嵌套 Text。
    return out.some((t) => t.cls) ? out : null
  }, [code, lang])
  return (
    <View style={[st.box, { borderColor: c.border, backgroundColor: c.bg2 }]}>
      {/* ★这一行的高度现在由复制按钮自己撑(它带 33pt 高的 padding,见 `CopyBtn.tsx`:hitSlop 在
          紧贴着它的祖先里是死的,可点区域只能靠 padding 长出来)。所以这里把 `st.head` 自己那
          9pt 上下内边距和右内边距去掉 —— 不去掉就是 9+33+9=51pt 的一条大帽子。折叠占位那边
          (`HtmlFallback`)没有这颗按钮,仍旧用原样的 `st.head`,别把它一起改了。 */}
      <View style={[st.head, st.headCode, open && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }]}>
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
            {toks ? toks.map((t, i) => (t.cls ? <T key={i} style={[st.tok, synStyle(t.cls, c)]}>{t.text}</T> : t.text)) : code}
          </T>
        </ScrollView>
      ) : null}
    </View>
  )
}

/**
 * 生成中那个末尾光标。**它会闪。**
 *
 * ★★原来是一个静止的 `▍`。一个不动的光标传达的信息恰好是反的 —— 光标之所以是「还在写」的
 *  标志,全靠它在闪;不闪的那个更像**画面卡住了**。电脑端从来是闪的
 *  (`chat.css` 的 `caret-blink 1s steps(2) infinite`),手机端漏了。
 * ★`steps(2)` 的硬闪,不是渐隐渐现:两边节奏必须一样,不然同一个东西在两块屏上是两种性格。
 * ★`useNativeDriver`:透明度动画交给 UI 线程,JS 线程正忙着解析流式吐进来的 markdown ——
 *  放在 JS 线程上的话,恰恰在最需要它动的时候它最卡。
 * ★★关掉动画偏好(系统设置里的「减弱动态效果」)时**不闪,但仍然显示**:光标是状态指示,
 *  不是装饰,不能因为不闪就不画。
 */
function Caret() {
  const c = useC()
  const op = useRef(new Animated.Value(1)).current
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => { if (alive) setReduce(v) })
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (v) => setReduce(v))
    return () => { alive = false; sub.remove() }
  }, [])
  useEffect(() => {
    if (reduce) { op.setValue(1); return }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0, duration: 0, delay: 530, useNativeDriver: true }),
        Animated.timing(op, { toValue: 1, duration: 0, delay: 530, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => { loop.stop(); op.setValue(1) }
  }, [reduce, op])
  return <Animated.Text style={{ color: c.accent, fontSize: 15, opacity: op }}>▍</Animated.Text>
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
          /* ★★2026-09-01:这里原来是 `<T>{ch.text}</T>` —— **手机端从来就没有 markdown 渲染**。
              于是表格是原始竖线 `|---|---|`、`**` 和反引号原样露出、标题和列表全是平的
              (用户发截图报的就是这个)。
             ★渲染器用的是**内嵌 HTML 那一个**(`HtmlRender`),不是另写一套:markdown 要画的东西
              (标题/表格/列表/引用/粗斜体/行内代码/链接)和它完全重合。共用一个 ⇒ 同一段内容
              不管模型吐的是 HTML 还是 markdown,长出来必然一样;各写一套迟早分叉,而分叉那天
              没有任何测试会红。 */
          <MdBlock key={i} text={ch.text} />
        ),
      )}
      {streaming ? <Caret /> : null}
    </View>
  )
}

const st = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 11, marginVertical: 6, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, paddingVertical: 9 },
  // 代码块那一行专用:高度让给复制按钮自己的 padding(见上面那段注释)。左边 11 留着,
  // 右边交给按钮 —— 它自己就带 11pt 右内边距,再叠一层字就离边框太远了。
  headCode: { paddingVertical: 0, paddingRight: 0 },
  // 代码本体。`padding` 走 contentContainer 而不是 ScrollView 自己 —— 不然横向滚到底时右边那圈
  // 内边距会跟着滚走,最后一列字贴着边框。
  codeBody: { paddingHorizontal: 11, paddingTop: 8, paddingBottom: 10 },
  // 一个语法 token。★**故意不带 lineHeight**:嵌套 `<Text>` 各自带行高在 Android 上会让同一行忽高忽低。
  // 行高由外层那个 `<T>` 一处定;里面的只管字体和字号(`T` 要靠 fontSize 落「正文字号」那三档)。
  tok: { fontFamily: MONO, fontSize: 11.5 },
})
