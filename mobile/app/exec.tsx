import { useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { goBack } from '../src/nav'
import type { DiffLine } from '../../src/shared/types'
import { MONO, useC } from '../src/theme/theme'
import { Empty, Field, IconBtn, List, Note, Row, Sec, T, Tabs, TopBar, TopTitle } from '../src/ui/kit'
import { crumbs, filterEntries, listDir, numberLines, parentOf, type Entry } from '../src/ui/fileTree'
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

/** 带行号的代码/差异行。变更和全文两屏共用这一段版式(原型的 `.code`)。 */
function CodeLines({
  lines,
}: {
  lines: { ln: string; text: string; kind: 'ctx' | 'add' | 'del' }[]
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
          <T style={[st.code, { color: c.fg2 }]}>{l.text || ' '}</T>
        </View>
      ))}
    </>
  )
}

export default function Exec() {
  const c = useC()
  const { online } = useConn()
  const { selected, wsName } = useStore()
  const { groups, total, loading, error, diff } = useChanges(selected?.wsPath ?? null)
  const [pane, setPane] = useState<Pane>('changes')
  const [open, setOpen] = useState<Open | null>(null)

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
  if (open) {
    const view = numberLines(code?.text ?? '')
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
                  lines={lines.map((l) => ({ ln: String(l.ln || ''), text: (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text, kind: l.kind === 'add' ? 'add' : l.kind === 'del' ? 'del' : 'ctx' }))}
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
                <CodeLines lines={view.lines.map((l) => ({ ln: String(l.ln), text: l.text, kind: 'ctx' as const }))} />
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
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={st.projs}>
              {projects.map((g) => {
                const on = g.cwd === proj
                return (
                  <Row
                    key={g.cwd}
                    onPress={() => {
                      setProj(g.cwd)
                      setDir('')
                      setQ('')
                    }}
                    style={[st.proj, on ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined]}
                  >
                    <T style={{ fontSize: 12.5, color: on ? c.fg : c.muted }}>{g.name}</T>
                  </Row>
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
              <List>
                {up != null ? (
                  <Row onPress={() => setDir(up)}>
                    <T mono style={{ fontSize: 12.5, color: c.muted }}>‹ ..</T>
                  </Row>
                ) : null}
                {shown.length === 0 ? (
                  <Row>
                    <T style={{ fontSize: 12.5, color: c.faint }}>{q.trim() ? '这一层没有匹配的名字' : '这个目录是空的'}</T>
                  </Row>
                ) : null}
                {shown.map((e) => (
                  <Row
                    key={e.path}
                    onPress={() => (e.type === 'dir' ? (setDir(e.path), setQ('')) : openFile(proj!, e.path, 'code'))}
                  >
                    <T style={{ fontSize: 12, color: c.faint, width: 14 }}>{e.type === 'dir' ? '▸' : '·'}</T>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T numberOfLines={1} mono style={{ fontSize: 12.5, color: c.fg }}>
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
    </View>
  )
}

const st = StyleSheet.create({
  line: { flexDirection: 'row', paddingHorizontal: 4 },
  ln: { width: 44, textAlign: 'right', paddingRight: 9, fontFamily: MONO, fontSize: 11.5, lineHeight: 20 },
  code: { fontFamily: MONO, fontSize: 11.5, lineHeight: 20, paddingRight: 12 },
  projs: { flexDirection: 'row', gap: 7, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 },
  proj: { paddingHorizontal: 11, paddingVertical: 7, borderRadius: 9, minHeight: 0 },
  crumb: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
})
