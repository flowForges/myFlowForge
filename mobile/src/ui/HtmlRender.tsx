import type { ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, View } from 'react-native'
import { useC } from '../theme/theme'
import type { Palette } from '../theme/tokens'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'
import type { HNode } from './htmlParse'

/**
 * `htmlParse.ts` 出的那棵树 → React Native 原语。
 *
 * ★**只有 RN 原语**,没有 WebView —— 这是用户当场拍板的(不想再多一个原生依赖)。
 *  所以能画的就这么多:表格、有序/无序列表、标题、粗斜体、链接、行内/块代码、段落、引用、分隔线。
 *  画不了的在**解析那一层**就整段退回了(见 `htmlParse.ts`),走不到这里 ——
 *  这个文件里没有任何「遇到不认识的就跳过」的分支,那种分支正是「画一半还让人以为是全部」的来源。
 *
 * ★颜色一律走 `theme/tokens.ts`。这里一个字面色值都不许有:壁纸配色 / 深浅主题都靠令牌跟着走。
 * ★**不联网**:没有 `<img>`(解析层就不放行),链接也只在**人主动点**的时候交给系统浏览器,
 *  app 自己不发任何请求。
 */

type El = Extract<HNode, { t: 'el' }>

/** 块级:自己占一行,不能塞进 `<Text>` 里。其余按行内处理。 */
const BLOCK = new Set(['p', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'hr', 'table'])

/** 标题字号。h1 刻意只有 19 —— 这是**对话气泡里的一段片段**,不是一整屏文档,压不住太大的字。 */
const H_SIZE: Record<string, number> = { h1: 19, h2: 17, h3: 15.5, h4: 14.5, h5: 14, h6: 13.5 }

const openUrl = (href: string): void => {
  // 打不开(没有对应 app / 系统拒绝)就什么都不做。弹一个「打不开」的错对读者毫无用处。
  void Linking.openURL(href).catch(() => {})
}

function inlineKids(kids: HNode[], c: Palette, key: string): ReactNode[] {
  return kids.map((k, i) => renderInline(k, c, `${key}-${i}`))
}

function renderInline(n: HNode, c: Palette, key: string): ReactNode {
  if (n.t === 'text') return n.text
  switch (n.tag) {
    // ★`<br>` 直接给一个换行符而不是画一个空 View:它在 `<Text>` 内部,塞 View 进去在 Android 上
    //  会把整行的基线顶歪。
    case 'br': return '\n'
    case 'strong':
    case 'b':
      return <T key={key} style={{ fontWeight: '700', color: c.fg }}>{inlineKids(n.kids, c, key)}</T>
    case 'em':
    case 'i':
      return <T key={key} style={{ fontStyle: 'italic' }}>{inlineKids(n.kids, c, key)}</T>
    case 'del':
      return <T key={key} style={{ textDecorationLine: 'line-through', color: c.muted }}>{inlineKids(n.kids, c, key)}</T>
    case 'small':
      return <T key={key} style={{ fontSize: 12.5, color: c.muted }}>{inlineKids(n.kids, c, key)}</T>
    case 'code':
      // 行内代码。底色用 `surface2`(中性面),不是彩色 —— 全屏唯一的实底彩色块留给权限门。
      return (
        <T key={key} mono style={{ fontSize: 13, color: c.fg, backgroundColor: c.surface2 }}>
          {' '}{inlineKids(n.kids, c, key)}{' '}
        </T>
      )
    case 'a':
      return (
        <T
          key={key}
          onPress={n.href ? () => openUrl(n.href!) : undefined}
          style={{ color: c.accent, textDecorationLine: 'underline' }}
        >
          {inlineKids(n.kids, c, key)}
        </T>
      )
    default:
      // span 和任何被当成行内的东西:只把内容透出来,不加样式。
      return <T key={key}>{inlineKids(n.kids, c, key)}</T>
  }
}

/**
 * 一串子节点 → 块的序列。**连着的行内节点攒成一段**再出 —— 一个字一个 `<Text>` 的话
 * 换行会在每个 token 之间断开,一句话被切成阶梯状。
 */
function renderFlow(nodes: HNode[], c: Palette, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let run: HNode[] = []
  const flushRun = (): void => {
    if (!run.length) return
    const kids = run
    run = []
    // 纯空白的一段不单独成段(块与块之间的换行缩进)。
    if (kids.every((k) => k.t === 'text' && !k.text.trim())) return
    out.push(
      <T key={`${key}-r${out.length}`} style={{ fontSize: 15, lineHeight: 24, color: c.fg2, marginBottom: 6 }}>
        {inlineKids(kids, c, `${key}-r${out.length}`)}
      </T>,
    )
  }
  for (const n of nodes) {
    if (n.t === 'el' && BLOCK.has(n.tag)) {
      flushRun()
      out.push(renderBlock(n, c, `${key}-b${out.length}`))
    } else run.push(n)
  }
  flushRun()
  return out
}

/** `<table>` 里的行:thead / tbody 是可有可无的一层,拍平掉。 */
function rowsOf(table: El): El[] {
  const out: El[] = []
  for (const k of table.kids) {
    if (k.t !== 'el') continue
    if (k.tag === 'tr') out.push(k)
    else if (k.tag === 'thead' || k.tag === 'tbody') {
      for (const r of k.kids) if (r.t === 'el' && r.tag === 'tr') out.push(r)
    }
  }
  return out
}

function renderBlock(n: El, c: Palette, key: string): ReactNode {
  switch (n.tag) {
    case 'hr':
      return <View key={key} style={[st.hr, { backgroundColor: c.border2 }]} />
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return (
        <T key={key} style={{ fontSize: H_SIZE[n.tag], lineHeight: H_SIZE[n.tag] * 1.45, fontWeight: '700', color: c.fg, marginTop: 8, marginBottom: 4 }}>
          {inlineKids(n.kids, c, key)}
        </T>
      )
    case 'p':
      return (
        <T key={key} style={{ fontSize: 15, lineHeight: 24, color: c.fg2, marginBottom: 8 }}>
          {inlineKids(n.kids, c, key)}
        </T>
      )
    case 'blockquote':
      return (
        <View key={key} style={[st.quote, { borderLeftColor: c.border2 }]}>
          {renderFlow(n.kids, c, key)}
        </View>
      )
    case 'pre':
      // 代码块。★横向滚动而不是折行 —— 和对话里的 ``` 代码块同一条理由:命令和缩进一折行就读不出结构。
      return (
        <ScrollView
          key={key}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[st.pre, { borderColor: c.border, backgroundColor: c.bg2 }]}
          contentContainerStyle={st.preBody}
        >
          <T mono style={{ fontSize: 11.5, lineHeight: 18, color: c.fg2 }}>
            {flatText(n.kids)}
          </T>
        </ScrollView>
      )
    case 'ul': case 'ol': {
      const items = n.kids.filter((k): k is El => k.t === 'el' && k.tag === 'li')
      return (
        <View key={key} style={{ marginBottom: 6 }}>
          {items.map((li, i) => (
            <View key={i} style={st.li}>
              {/* 记号列宽度写死:序号从 9 变 10 时,内容那一列不该跟着往右跳。 */}
              <T mono style={[st.marker, { color: c.muted }]}>{n.tag === 'ol' ? `${i + 1}.` : '•'}</T>
              <View style={{ flex: 1, minWidth: 0 }}>{renderFlow(li.kids, c, `${key}-${i}`)}</View>
            </View>
          ))}
        </View>
      )
    }
    case 'table': {
      const rows = rowsOf(n)
      return (
        <View key={key} style={[st.table, { borderColor: c.border }]}>
          {rows.map((r, ri) => {
            const cells = r.kids.filter((k): k is El => k.t === 'el' && (k.tag === 'th' || k.tag === 'td'))
            const head = cells.some((x) => x.tag === 'th')
            return (
              <View key={ri} style={[st.tr, ri > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}>
                {cells.map((cell, ci) => (
                  <View
                    key={ci}
                    // colspan 落成 flex 权重:RN 没有表格布局,等宽 + 权重是最接近的忠实近似。
                    style={[st.td, { flex: cell.colSpan ?? 1 }, ci > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.border }, head && { backgroundColor: c.surface2 }]}
                  >
                    <T style={{ fontSize: 13, lineHeight: 19, color: head ? c.fg : c.fg2, fontWeight: head ? '600' : '400' }}>
                      {inlineKids(cell.kids, c, `${key}-${ri}-${ci}`)}
                    </T>
                  </View>
                ))}
              </View>
            )
          })}
        </View>
      )
    }
    // div / li(直接出现在顶层时):纯容器,只管把里面的流排下去。
    default:
      return <View key={key}>{renderFlow(n.kids, c, key)}</View>
  }
}

/** `<pre>` 里只要文字(里面可能还嵌着 `<code>`)。 */
function flatText(nodes: HNode[]): string {
  return nodes.map((n) => (n.t === 'text' ? n.text : n.tag === 'br' ? '\n' : flatText(n.kids))).join('')
}

export function HtmlRender({ nodes }: { nodes: HNode[] }) {
  const c = useC()
  return <View style={st.root}>{renderFlow(nodes, c, 'h')}</View>
}

const st = StyleSheet.create({
  root: { marginVertical: 6 },
  hr: { height: StyleSheet.hairlineWidth, marginVertical: 10 },
  quote: { borderLeftWidth: 2, paddingLeft: 10, marginBottom: 6 },
  pre: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.ctl, marginBottom: 8 },
  preBody: { paddingHorizontal: 11, paddingVertical: 9 },
  li: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 2 },
  marker: { width: 22, fontSize: 13, lineHeight: 24, textAlign: 'right', paddingRight: 7 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.chip, overflow: 'hidden', marginBottom: 8 },
  tr: { flexDirection: 'row', alignItems: 'stretch' },
  td: { paddingHorizontal: 9, paddingVertical: 7 },
})
