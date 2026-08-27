import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { goBack } from '../src/nav'
import { one } from '../src/routeParams'
import type { DiffLine } from '../../src/shared/types'
import { MONO, useC } from '../src/theme/theme'
import { RADIUS, type Palette } from '../src/theme/tokens'
import { Chip, Empty, Field, IconBtn, List, Note, Row, Sec, T, Tabs, TopBar, TopTitle } from '../src/ui/kit'
import { GateCard } from '../src/ui/GateCard'
import { HIGHLIGHT_MAX, highlight } from '@shared/highlight'
import { synStyle } from '../src/ui/synStyle'
import {
  crumbs,
  extBadge,
  fileKind,
  filterEntries,
  langOf,
  listDir,
  numberLines,
  parentOf,
  type Entry,
  type FileKind,
} from '../src/ui/fileTree'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useChanges } from '../src/data/useChanges'
import { useFiles } from '../src/data/useFiles'

/**
 * 执行面板 · 变更 + 文件。
 *
 * 桌面端右栏是「阶段 / 变更 / 文件 / 终端」四个 tab。手机端做前面两个:
 * **变更**是「敢不敢让它继续」的唯一依据(门上按允许之前你想看的就是它改了什么),
 * **文件**是紧随其后的那一步 —— 光看 diff 常常不够,你要看改动落在什么上下文里。
 * 阶段和终端留着:阶段在对话里已经有工作流条了,终端要 `term:*` 进方法表(跨桌面端的改动)。
 *
 * ★整屏推入(右上角进,左上角返回),不是底部上滑 —— 原型 B 版被否掉的正是那个看不见的手势。
 * ★**只读**。手机上不提交、不回滚、不写文件。
 */

type Pane = 'changes' | 'files'
/** 打开的那个文件,以及现在看的是全文还是变更。原型 `v-file` 右上角那个图标就是切这个的。 */
type Open = { cwd: string; file: string; view: 'diff' | 'code' }

/**
 * 文件大类 → 那枚扩展名小字的颜色。
 *
 * ★色值一律借**语法着色**那一组(`syn*`):它们本来就是「同一屏里区分种类、但都不抢戏」的一组,
 *  互相之间的色相拉得够开,亮度又都压在正文之下。另配一组新颜色只会多出四个没人维护的令牌。
 * ★认不出类型的用 `faint`,和原来那个 `·` 一样安静 —— 不认识就别装作认识。
 */
function kindColor(k: FileKind, c: Palette): string {
  switch (k) {
    case 'code': return c.synFn
    case 'markup': return c.synKw
    case 'data': return c.synPr
    case 'doc': return c.synCm
    case 'media': return c.synVa
    case 'other': return c.faint
  }
}

/**
 * 带行号的代码/差异行。变更和全文两屏共用这一段版式(原型的 `.code`)。
 *
 * ★用户原话:「打开文件后没有渲染,感觉就普通文本一样」。所以这里逐行过 `@shared/highlight` 的
 *  `highlight()` —— **和电脑端是同一份语法表**(见 `FilePreview.tsx`),同一个文件在两块屏幕上
 *  认出的关键字一样多。逐行那条路只产出 kw/st/cm/nu 四个色位(行内看不到跨行的块注释和多行字符串,
 *  猜的话会把半个文件染成注释),这是刻意的。
 */
function CodeLines({
  lines,
  lang,
  colorize,
}: {
  /** `prefix` 是 diff 的 `+` / `-` / 空格。它**不是代码**,单独渲染。 */
  lines: { ln: string; prefix?: string; text: string; kind: 'ctx' | 'add' | 'del' }[]
  lang: string
  /** 关掉着色(超长文件 / 认不出语言)时整行走一个 `<T>`,不切 token。 */
  colorize: boolean
}) {
  const c = useC()
  return (
    <>
      {lines.map((l, i) => (
        <View
          key={i}
          style={[
            st.line,
            l.kind === 'add' ? { backgroundColor: c.addBg } : l.kind === 'del' ? { backgroundColor: c.delBg } : null,
          ]}
        >
          <T style={[st.ln, { color: c.faint }]}>{l.ln}</T>
          <T style={[st.code, { color: c.fg2 }]}>
            {/* ★`+` / `-` 用 `c.faint` 单独出:它是 diff 的记号,不是这一行代码的一部分。
                跟着进 `highlight()` 的话 `-x` 会被当成运算符、`+1` 会被当成数字 —— 一列本该
                安静的记号忽然五颜六色,而整行的底色本来已经把增删说清楚了。 */}
            {l.prefix ? <T style={[st.tok, { color: c.faint }]}>{l.prefix}</T> : null}
            {!colorize
              ? l.text || (l.prefix ? '' : ' ')
              : l.text
                ? highlight(l.text, lang).map((t, j) =>
                    t.cls ? (
                      <T key={j} style={[st.tok, synStyle(t.cls, c)]}>
                        {t.text}
                      </T>
                    ) : (
                      t.text
                    ),
                  )
                : // 空行也要占一行高度,不然一屏代码里的空行全被压扁,缩进结构就读不出来了。
                  l.prefix
                  ? ''
                  : ' '}
          </T>
        </View>
      ))}
    </>
  )
}

export default function Exec() {
  const c = useC()
  const { online } = useConn()
  const { selected, wsName, sessionTitle, gates, answerGate } = useStore()
  const { groups, total, loading, error, diff } = useChanges(selected?.wsPath ?? null)
  const [pane, setPane] = useState<Pane>('changes')
  const [open, setOpen] = useState<Open | null>(null)

  // ── 从门上「👁 看看」推进来的那道门 ─────────────────────────────────────
  // 带 `?gate=<id>` 进来就把那道门原样钉在这一屏底下:人是为了「按允许之前先看看它改了什么」
  // 才来的,看完就地答,不用再退回对话屏把门找一遍。
  const { gate: gateParam } = useLocalSearchParams<{ gate?: string }>()
  const gateId = one(gateParam)
  const pinned = useMemo(() => (gateId ? (gates.find((g) => g.id === gateId) ?? null) : null), [gates, gateId])
  const [gateErr, setGateErr] = useState<string | null>(null)
  /**
   * ★**「这道门是我自己正在答的」**,不是别人抢答的。
   *
   *  `answerGate`(`store.tsx`)是**乐观**的:它在发请求之前就先 `dropGate(g.id)` 把门从
   *  store 里摘掉了 —— 那是故意的,卡片在往返那一两秒里杵着不动会让人以为没点上、再点一次。
   *  可代价是 `pinned`(`gates.find(...)` 推出来的)在**下一帧**就变成 null,比 `goBack()` 早。
   *  底下那行「那道门已经被答掉了(可能是在电脑上)」于是会对着**刚按完允许的本人**显示一整个
   *  往返 —— 链路一慢就是好几秒。那句话本来是为了防张冠李戴,这么一来冤枉的成了用户自己。
   *
   *  记下正在答的那个 id,只压住**这一个**。别的门(比如你在看 B 的 diff,电脑上把 A 答了)
   *  那句话仍旧是对的,照常显示。
   */
  const [answering, setAnswering] = useState<string | null>(null)

  const answerPinned = async (decision: 'allow' | 'deny') => {
    if (!pinned) return
    setGateErr(null)
    setAnswering(pinned.id)
    try {
      await answerGate(pinned, { decision })
      goBack()
    } catch (e) {
      // ★请求没送到时 `answerGate` 会把门**放回** store 并重新抛出(见 store.tsx 的 catch)。
      //  这里必须把标记一并清掉 —— 不清的话,这道门之后真被别的设备答掉时,那句提示
      //  永远不会再出现,而门是真的没了。
      setAnswering(null)
      setGateErr(e instanceof Error ? e.message : String(e))
    }
  }

  // 打开的那个文件的两种内容。切 tab 时**各自缓存**,来回切不重新请求。
  const [lines, setLines] = useState<DiffLine[] | null>(null)
  const [diffErr, setDiffErr] = useState<string | null>(null)
  const [code, setCode] = useState<{ text: string; lang: string } | null>(null)
  const [codeErr, setCodeErr] = useState<string | null>(null)

  // ── 文件浏览 ──────────────────────────────────────────────────────────
  // 项目就是变更面板里那几个;不另起一套推法(桌面端 WorkspaceView 也是同一套)。
  const projects = groups
  const [proj, setProj] = useState<string | null>(null)
  const [dir, setDir] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    if (!proj && projects.length) setProj(projects[0].cwd)
  }, [projects, proj])
  const projName = projects.find((g) => g.cwd === proj)?.name ?? ''
  const { tree, loading: treeLoading, error: treeErr, read } = useFiles(pane === 'files' ? proj : null)

  const entries: Entry[] | null = useMemo(() => (tree ? listDir(tree, dir) : null), [tree, dir])
  const shown = useMemo(() => (entries ? filterEntries(entries, q) : null), [entries, q])
  const up = parentOf(dir)

  const openFile = (cwd: string, file: string, view: Open['view']) => {
    setOpen({ cwd, file, view })
    setLines(null)
    setDiffErr(null)
    setCode(null)
    setCodeErr(null)
  }

  // 需要哪一半就拉哪一半。切到另一半时如果已经拉过就直接用缓存。
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      if (open.view === 'diff' && !lines && !diffErr) {
        try {
          const d = await diff(open.cwd, open.file)
          if (alive) setLines(d)
        } catch (e) {
          if (alive) setDiffErr(e instanceof Error ? e.message : String(e))
        }
      }
      if (open.view === 'code' && !code && !codeErr) {
        try {
          const f = await read(open.file)
          if (alive) setCode(f)
        } catch (e) {
          if (alive) setCodeErr(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // ── 打开了一个文件:全文 / 变更两屏 ───────────────────────────────────
  // ★这一支**不画钉住的门**:整屏都是代码,门是全屏唯一的实底彩色块,两个挤一起只会互相打架
  //  (而且这一屏横竖两层 ScrollView,底下再压一条会把可读的行数吃掉一截)。
  //  左上角 ‹ 退回文件列表,门就又在了。
  if (open) {
    const view = numberLines(code?.text ?? '')
    // 这一屏按哪种语言着色。服务端只在 `git:file` 里给 lang,而且认不出时给的是 'text' ——
    // 见 `langOf` 的注释。diff 那一半根本没有 lang,只能按文件名推。
    const lang = langOf(open.file, code?.lang)
    /**
     * ★`HIGHLIGHT_MAX` 是着色器自己定的闸(60k 字符):一个几万字符的文件切成上万个 `<T>`,
     *  在 RN 里就是一次几秒的卡顿 —— 手机上比电脑端更疼。超了就整行一个 `<T>` 打印,
     *  内容一个字不少,只是没颜色。
     * ★注意这跟 `FILE_LINE_CAP`(800 行)是**两条不同的闸**:那条是「只显示前 N 行」并且
     *  界面上如实说了;这条只关掉颜色,不藏任何内容,所以不需要另写一句提示。
     */
    const codeLen = code?.text.length ?? 0
    const diffLen = lines ? lines.reduce((n, l) => n + l.text.length + 1, 0) : 0
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar
          left={<IconBtn onPress={() => setOpen(null)}>‹</IconBtn>}
          right={
            <IconBtn onPress={() => setOpen({ ...open, view: open.view === 'diff' ? 'code' : 'diff' })}>
              {open.view === 'diff' ? '⌗' : '±'}
            </IconBtn>
          }
        >
          <TopTitle
            title={open.file.split('/').pop() ?? open.file}
            sub={
              open.view === 'diff'
                ? `变更 · ${open.file}`
                : `全文 · ${view.total} 行${code?.lang ? ' · ' + code.lang : ''}`
            }
          />
        </TopBar>
        <ScrollView horizontal contentContainerStyle={{ minWidth: '100%' }}>
          <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingBottom: 40 }}>
            {open.view === 'diff' ? (
              diffErr ? (
                <Empty title="读不到这个文件的 diff" desc={diffErr} />
              ) : !lines ? (
                <Empty title="正在读取…" />
              ) : lines.length === 0 ? (
                <Empty title="没有可显示的差异" desc="这个文件和 HEAD 一样。右上角可以切到全文。" />
              ) : (
                <CodeLines
                  lang={lang}
                  colorize={diffLen <= HIGHLIGHT_MAX}
                  lines={lines.map((l) => ({ ln: String(l.ln || ''), prefix: l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ', text: l.text, kind: l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : 'ctx' }))}
                />
              )
            ) : codeErr ? (
              <Empty title="读不到这个文件" desc={codeErr} />
            ) : !code ? (
              <Empty title="正在读取…" />
            ) : view.total === 0 ? (
              <Empty title="这个文件是空的" />
            ) : (
              <>
                <CodeLines
                  lang={lang}
                  colorize={codeLen <= HIGHLIGHT_MAX}
                  lines={view.lines.map((l) => ({ ln: String(l.ln), text: l.text, kind: 'ctx' as const }))}
                />
                {/* ★截断必须说出来。人正是拿这一屏判断「敢不敢让它继续」。 */}
                {view.dropped > 0 ? (
                  <T style={{ fontSize: 11.5, color: c.faint, paddingHorizontal: 12, paddingTop: 8 }}>
                    只显示前 {view.lines.length} 行,还有 {view.dropped} 行没显示(共 {view.total} 行)
                  </T>
                ) : null}
              </>
            )}
          </ScrollView>
        </ScrollView>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle
          title="执行"
          sub={selected ? `${wsName(selected.wsPath)} · ${total.total} 个文件 +${total.add} −${total.del}` : '未选会话'}
        />
      </TopBar>

      <Tabs<Pane>
        items={[
          { key: 'changes', label: '变更' },
          { key: 'files', label: '文件' },
        ]}
        value={pane}
        onChange={setPane}
      />

      {!online ? (
        <Empty title="未连接" desc="变更和文件都是现读的,连上才有。" />
      ) : !selected ? (
        <Empty title="先选一个会话" />
      ) : pane === 'changes' ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          {loading ? (
            <Empty title="正在读取…" />
          ) : error ? (
            <Empty title="读不到变更" desc={error} />
          ) : total.total === 0 ? (
            <Empty title="工作树是干净的" desc="代理还没动过文件,或者改动已经提交了。" />
          ) : (
            groups
              .filter((g) => g.changes.length > 0)
              .map((g) => (
                <View key={g.cwd}>
                  <Sec
                    right={
                      <T mono style={{ fontSize: 10.5, color: c.faint }}>
                        {g.changes.length} 个文件
                      </T>
                    }
                  >
                    {g.name}
                  </Sec>
                  <List>
                    {g.changes.map((ch) => (
                      <Row key={ch.path} onPress={() => openFile(g.cwd, ch.path, 'diff')}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T numberOfLines={1} mono style={{ fontSize: 12.5, color: c.fg }}>
                            {ch.path}
                          </T>
                        </View>
                        <T mono style={{ fontSize: 11.5, color: c.add }}>
                          +{ch.add}
                        </T>
                        <T mono style={{ fontSize: 11.5, color: c.del }}>
                          −{ch.del}
                        </T>
                      </Row>
                    ))}
                  </List>
                </View>
              ))
          )}
          <Note>只读。手机上不提交、不回滚 —— 那些留在电脑端。点开一个文件,右上角能在变更和全文之间切。</Note>
        </ScrollView>
      ) : (
        // ── 文件 ────────────────────────────────────────────────────────
        <View style={{ flex: 1 }}>
          {projects.length > 1 ? (
            // ★用 `Chip` 而不是 `Row`:`Row` 是**整宽的列表卡**(`width: '100%'` + `minHeight: 54`),
            //  塞进横向 ScrollView 里就是一个撑满屏宽、又被上面那点高度切掉一半的方框,还压在
            //  底下的面包屑上 —— 真机截图里 `go-blog` 出现两次、上面那个被削平,就是这个。
            //  这一排本来要的就是 chip:32 高、内容宽、`RADIUS.chip` 的圆角。
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={st.projs}>
              {projects.map((g) => {
                const on = g.cwd === proj
                return (
                  <Chip
                    key={g.cwd}
                    // 选中态照旧是 accent 边 + accentDim 底(和代理/权限那两张 Sheet 里的选中行同一套),
                    // 文字跟着从 muted 抬到 fg —— 只换边框的话,余光扫过去分不出选的是哪一个。
                    tone={on ? 'on' : 'plain'}
                    onPress={() => {
                      setProj(g.cwd)
                      setDir('')
                      setQ('')
                    }}
                    style={on ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}
                  >
                    {g.name}
                  </Chip>
                )
              })}
            </ScrollView>
          ) : null}

          {/* 面包屑:每一段都能点回去。原型 files.html 的 `.crumb`。 */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={st.crumb}>
            {crumbs(projName || '项目', dir).map((cr, i, all) => (
              <View key={cr.path + i} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T
                  onPress={() => {
                    setDir(cr.path)
                    setQ('')
                  }}
                  mono
                  style={{ fontSize: 11.5, color: i === all.length - 1 ? c.fg2 : c.muted }}
                >
                  {cr.name}
                </T>
                {i < all.length - 1 ? <T mono style={{ fontSize: 11.5, color: c.faint }}> / </T> : null}
              </View>
            ))}
          </ScrollView>

          <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
            <Field value={q} onChangeText={setQ} placeholder="按文件名过滤…" style={{ minHeight: 38, paddingVertical: 8, fontSize: 14 }} />
          </View>

          <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
            {treeLoading ? (
              <Empty title="正在读取文件树…" />
            ) : treeErr ? (
              <Empty title="读不到文件树" desc={treeErr} />
            ) : !projects.length ? (
              <Empty title="这个工作区里没有项目" />
            ) : !shown ? (
              <Empty title="这个目录不在了" desc="文件树是进来那一刻读的,代理可能已经把它删了。" />
            ) : (
              // 原型的 `.tree`:行更矮、无边框,一屏才装得下一列文件名。
              <List style={{ gap: 2 }}>
                {up != null ? (
                  <Row tree onPress={() => setDir(up)}>
                    <T mono style={{ fontSize: 12.5, color: c.muted }}>‹ ..</T>
                  </Row>
                ) : null}
                {shown.length === 0 ? (
                  <Row tree>
                    <T style={{ fontSize: 12.5, color: c.faint }}>{q.trim() ? '这一层没有匹配的名字' : '这个目录是空的'}</T>
                  </Row>
                ) : null}
                {shown.map((e) => (
                  <Row
                    key={e.path}
                    tree
                    onPress={() => (e.type === 'dir' ? (setDir(e.path), setQ('')) : openFile(proj!, e.path, 'code'))}
                  >
                    {/* ── 「文件列表感觉很素」的解法 ──────────────────────────────────
                        原来每一行左边都是同一个 `·`、名字同一个颜色同一个字重,一屏几十行没有任何
                        落点,找 `package.json` 只能一行行读过去。
                        ★电脑端(`inspector/fileIcon.tsx`)的做法是一枚实底彩色徽章 —— 手机端**不能抄**:
                         全屏唯一的实底彩色块必须继续只有权限门那一个(原型 d.css 第三条原则),
                         列表里铺几十个小色块,门就不再是一眼能认出的那个东西了。
                        ★所以只动三样**不占实底**的:①左边一枚淡色扩展名小字(类型),
                         ②目录名加粗、文件名常规(层级),③目录的 `▸` 用 accent(可进入 vs 可打开)。 */}
                    {e.type === 'dir' ? (
                      <T style={{ fontSize: 12, color: c.accent, width: 30 }}>▸</T>
                    ) : (
                      <T style={[st.badge, { color: kindColor(fileKind(e.name), c) }]} numberOfLines={1}>
                        {extBadge(e.name)}
                      </T>
                    )}
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T
                        numberOfLines={1}
                        mono
                        style={{ fontSize: 12.5, color: e.type === 'dir' ? c.fg : c.fg2, fontWeight: e.type === 'dir' ? '600' : '400' }}
                      >
                        {e.name}
                        {e.type === 'dir' ? '/' : ''}
                      </T>
                    </View>
                    {e.branch ? (
                      <T mono style={{ fontSize: 10.5, color: c.faint }}>{e.branch}</T>
                    ) : null}
                    {/* ChangeType 是 git 的 A/M/D,不是自造的字符串。翻成人话再显示。 */}
                    {e.chg ? (
                      <T mono style={{ fontSize: 10.5, color: e.chg === 'A' ? c.add : e.chg === 'D' ? c.del : c.warn }}>
                        {e.chg === 'A' ? '新增' : e.chg === 'D' ? '删除' : '已改'}
                      </T>
                    ) : null}
                    {e.count != null ? (
                      <T mono style={{ fontSize: 10.5, color: c.faint }}>{e.count} 项</T>
                    ) : null}
                  </Row>
                ))}
              </List>
            )}
            <Note>只读浏览。文件树是进这一屏时一次读回来的,翻目录不再打服务端。</Note>
          </ScrollView>
        </View>
      )}

      {/* ── 钉住的门:和对话屏同一个位置(整屏最底下、ScrollView 外面) ────────── */}
      {/* ★也**不参与滚动**。它是全屏唯一的实底彩色块,滚走了这颗「看看」就白点了。 */}
      {gateId ? (
        // ★`marginTop: 'auto'` 是因为这一屏的几个空态(未连接 / 先选一个会话 / 工作树是干净的)
        //  都不撑满高度 —— 不推到底,门会吊在半空中跟着空态文案走。ScrollView 自带 flexGrow,
        //  有内容那几支照旧被撑到底,这行不生效。
        <View style={{ marginTop: 'auto', paddingHorizontal: 10, paddingBottom: 10, backgroundColor: c.bg }}>
          {pinned ? (
            <>
              {gateErr ? <T style={{ fontSize: 12, color: c.err, paddingBottom: 6 }}>{gateErr}</T> : null}
              <GateCard
                gate={pinned}
                index={Math.max(0, gates.findIndex((g) => g.id === pinned.id))}
                total={gates.length}
                online={online}
                where={`${wsName(pinned.wsPath)} · ${sessionTitle(pinned.wsPath, pinned.sessionId)}`}
                onAllow={() => void answerPinned('allow')}
                onDeny={() => void answerPinned('deny')}
                // 已经在变更页上了,没有「再去看看」这回事。
                onOpen={() => goBack()}
              />
            </>
          ) : answering === gateId ? (
            // 是你自己刚按的,门已经乐观摘掉、请求还在路上。这时候只能说「正在提交」——
            // 说「被答掉了」就是在冤枉本人(见上面 `answering` 那段注释)。
            <T style={{ fontSize: 12.5, color: c.muted, paddingHorizontal: 5, paddingVertical: 10 }}>正在提交…</T>
          ) : (
            // ★门在你看 diff 的这会儿被**别的设备**答掉了 —— 这不是错误,但也不能就这么让卡片消失:
            //  原地什么都不留,人会以为是自己点错了、或者以为这一屏本来就没门。
            //
            //  ★分量:这行字要接住的是「你专程点『看看』过来要答的那个东西没了」,拿 `Note`
            //   那种 11.5pt 的 `c.faint` 灰字托不住 —— 眼睛正奔着底下那块琥珀去,落空了得有东西接住。
            //   所以给它一个**淡琥珀描边块**(`gateDim` 底 + `gateBorder` 边):占着门原来的位置和形状,
            //   视线落点不变。但它**不是实底** —— 全屏唯一的实底彩色块必须继续只有门那一个,
            //   门没了就没有实底块,这条正是「门在不在」的读法本身。
            <View style={[st.gone, { backgroundColor: c.gateDim, borderColor: c.gateBorder }]}>
              <T style={{ fontSize: 13.5, lineHeight: 20, color: c.fg2 }}>那道门已经被答掉了(可能是在电脑上)。</T>
            </View>
          )}
        </View>
      ) : null}
    </View>
  )
}

const st = StyleSheet.create({
  line: { flexDirection: 'row', paddingHorizontal: 4 },
  ln: { width: 44, textAlign: 'right', paddingRight: 9, fontFamily: MONO, fontSize: 11.5, lineHeight: 20 },
  code: { fontFamily: MONO, fontSize: 11.5, lineHeight: 20, paddingRight: 12 },
  // 一个语法 token。★**故意不带 lineHeight**:嵌套 `<Text>` 各自带行高在 Android 上会让同一行
  // 忽高忽低。行高由外层那个 `st.code` 一处定,里面的只管字体和字号(`T` 要靠 fontSize 落字号档)。
  tok: { fontFamily: MONO, fontSize: 11.5 },
  // 文件列表左边那一列。宽度**写死**,不然扩展名一长一短会让文件名的左边缘一行一个位置。
  badge: { width: 30, fontFamily: MONO, fontSize: 9.5, letterSpacing: 0.3 },
  // `alignItems: 'center'` 而不是默认的拉伸:chip 自己有 32 的 minHeight,拉伸会让它跟着
  // 这一条轨道的高度变形。paddingBottom 从 2 抬到 6 —— 原来贴着面包屑,现在两条各自站得开。
  projs: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 },
  crumb: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  // 门没了之后占它位置的那块。半径抄门的(`RADIUS.gate`),这样它接的是同一个视线落点。
  gone: {
    borderRadius: RADIUS.gate,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    paddingVertical: 13,
  },
})
