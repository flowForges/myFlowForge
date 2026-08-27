import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { goBack } from '../src/nav'
import { CH } from '../../src/main/ipc/channels'
import { deriveWorkBranch } from '../../src/shared/branchName'
import { indexCustomStages, type CustomStageDef } from '../../src/shared/customStages'
import { useC } from '../src/theme/theme'
import { Btn, Chip, Empty, Field, IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { RADIUS } from '../src/theme/tokens'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import {
  buildCreatePayload,
  checkWsName,
  classifyCreateError,
  filterProjects,
  joinPath,
  missingMethods,
  orderBrowseDirs,
  setupProgressText,
  stageLabels,
  whyNotCreate,
  type SetupEventLike,
  type WorkflowTemplate,
} from '../src/data/newWorkspace'

/**
 * 新建工作区(极简版 · 设计文档 §7.4)。
 *
 * ★**先纠正一处一直被重复的事实**:`workspace:create` / `config:list-projects` /
 *  `config:list-workflows` / `fs:browse` / `fs:browse-roots` 手机**全都拿得到**
 *  (`src/main/ipc/channelRouting.ts` 里既不在 `CLIENT_ONLY` 也不在 `DAEMON_UNSUPPORTED`)。
 *  被挡掉的只有 `dialog:pick-directory` / `dialog:pick-file` 那两个「弹系统对话框」的。
 *  所以手机上原来没有这一屏,是**产品决定**,不是技术限制。
 *
 * 三步,比电脑端那套向导小一个量级:
 *  1. 放哪儿 —— 浏主机的目录选一个**父目录**,再打一个名字。★不是「先建文件夹」:
 *     工作区那一层文件夹由服务端顺手建出来(`git/worktree.ts:76` 的
 *     `mkdirSync(dirname(worktreePath), { recursive: true })`),所以这里选的永远是**上一层**。
 *     ★因此**没有** `fs:mkdir` —— 那是一条从网络直达文件系统的写口子,按 §7.5 得单独一套
 *     逐条守卫 + 逐条变异验证,不该被这一屏顺手带出来。
 *  2. 哪些项目 —— 主机上已注册的 git 项目,勾选 + 每个一条分支。
 *     ★**没有「不同步」这个选项**:项目注册表就在主机上,手机勾的就是主机那一份。
 *     想要「手机加了主机不同步」得有第二份注册表 —— 不存在,也不该造。
 *  3. 用哪个工作流 —— 选一个。★**不在手机上编辑阶段**,那留在电脑上。
 *
 * 三条这个仓库栽过跟头的地方,在这一屏是硬要求:
 *  - **失败必须看得见。** 建区是真 clone,会中途失败;任何一条错误都要落在屏幕上,
 *    而不是一个转完就没了的圈(`app/index.tsx` 建会话那个 `catch` 的注释说的就是这件事)。
 *  - **断线必须是显式的。** 一个离线时看着还能操作的向导是在撒谎;主机没有某条方法时
 *    直接说是哪一条(决策 B-2)。
 *  - **长路径 / 长项目清单是常态**,不是边界情况。
 */

type Proj = { id: string; name: string; repoUrl?: string; defaultBranch?: string; alias?: string }
type BrowseEntry = { name: string; path: string; dir: boolean }
type BrowseResult = { path: string; parent: string | null; entries: BrowseEntry[]; error?: string }

export default function NewWorkspace() {
  const c = useC()
  const { invoke, online, methods, on } = useConn()
  const { refresh, ensureWs } = useStore()

  // —— 主机的三份清单(现问,不预置) ——
  const [projects, setProjects] = useState<Proj[]>([])
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([])
  const [stageDefs, setStageDefs] = useState<Record<string, CustomStageDef>>({})
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  // —— 第一步 ——
  const [parent, setParent] = useState<string | null>(null)
  /** 选定的那个父目录里已有的名字。用来提前说「这儿已经有一个同名文件夹了」。 */
  const [parentNames, setParentNames] = useState<string[]>([])
  const [name, setName] = useState('')
  const [browsing, setBrowsing] = useState(false)

  // —— 第二步 ——
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  /** 用户**手动改过**的分支。没改过的跟着工作区名字走,所以这里只存改过的那些。 */
  const [branchEdits, setBranchEdits] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')

  // —— 第三步 ——
  const [flowId, setFlowId] = useState<string | null>(null)

  // —— 创建过程 ——
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** 失败 / 取消之后留在那台机器上的半成品路径。给一颗「清掉」,否则残件等于隐形。 */
  const [partial, setPartial] = useState<string | null>(null)

  const missing = useMemo(() => missingMethods(methods), [methods])

  // 三份清单一起拉。任何一条失败都整屏报错 —— 缺了工作流或缺了阶段库,拼出来的
  // workspace:create 入参就是残缺的,而那种残缺**不会有任何报错**(阶段静默少一段提示词)。
  useEffect(() => {
    if (!online || missing.length) return
    let alive = true
    setLoading(true)
    setLoadErr(null)
    void (async () => {
      try {
        const [ps, ws, defs] = await Promise.all([
          invoke(CH.configListProjects, []) as Promise<Proj[]>,
          invoke(CH.configListWorkflows, []) as Promise<WorkflowTemplate[]>,
          invoke(CH.customStagesList, []) as Promise<CustomStageDef[]>,
        ])
        if (!alive) return
        setProjects(ps ?? [])
        setWorkflows(ws ?? [])
        setStageDefs(indexCustomStages(defs ?? []))
        setFlowId((cur) => cur ?? ws?.[0]?.id ?? null)
        setLoading(false)
      } catch (e) {
        if (!alive) return
        setLoadErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [invoke, online, missing.length])

  // 建区进度。★**整屏挂着**,不是「busy 的时候才订阅」:`setBusy(true)` 之后 effect 要等
  //  这一帧提交完才跑,而 `workspace:create` 的 invoke 是当场就发出去的 ——
  //  中间那一小段里 `setup:start` 和第一条 `provision:start` 会掉在地上。
  //  代价只是没在建区时也收几条别人(电脑端)触发的事件,而那几条只写进一个不显示的 state。
  useEffect(
    () =>
      on(CH.workspaceSetup, (p) => {
        const line = setupProgressText(p as SetupEventLike)
        if (line) setProgress(line)
      }),
    [on],
  )

  const nameCheck = checkWsName(name)
  const nameOk = nameCheck.ok
  const trimmed = nameOk ? nameCheck.name : ''
  const fullPath = parent && trimmed ? joinPath(parent, trimmed) : null
  const clash = !!trimmed && parentNames.includes(trimmed)

  // 默认分支 = `feat/<名字 slug>-<MMDD>`,和电脑端向导同一个函数,不另造一套。
  // 名字还没打时退回项目自己的默认分支,免得先显示一个 `feat/-0827`。
  const branchOf = useCallback(
    (p: Proj) => branchEdits[p.id] ?? (trimmed ? deriveWorkBranch(trimmed) : p.defaultBranch || 'main'),
    [branchEdits, trimmed],
  )

  const flow = workflows.find((w) => w.id === flowId) ?? null
  const shown = useMemo(() => filterProjects(projects, query), [projects, query])
  const blocked = whyNotCreate({
    online,
    missing,
    parent,
    name,
    projectCount: picked.size,
    workflowId: flowId,
    busy,
  })

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const create = async () => {
    if (!parent || !flow || !nameOk) return
    const payload = buildCreatePayload({
      name: trimmed,
      parent,
      workflow: flow,
      stageDefs,
      projects: projects.filter((p) => picked.has(p.id)).map((p) => ({ repoId: p.id, branch: branchOf(p) })),
    })
    setBusy(true)
    setErr(null)
    setPartial(null)
    setProgress('正在建立工作区…')
    try {
      const res = (await invoke(CH.workspaceCreate, [payload])) as { workspacePath?: string } | null
      const wsPath = res?.workspacePath || payload.path
      refresh()
      ensureWs(wsPath) // 回到列表时这个新区是展开的,不用再点一下
      setBusy(false)
      goBack()
    } catch (e) {
      // ★★**一个字都不许吞。** 建区是真 clone:没网、没权限、分支不存在、项目没注册,
      //  每一条都可能在这里出现,而「建失败了但界面什么也没说」是这一屏最坏的结局。
      const msg = e instanceof Error ? e.message : String(e)
      setBusy(false)
      setProgress(null)
      // 半成品留在磁盘上(主进程只摘掉侧栏记录,不删目录)—— 所以给出它的路径和一颗清除键。
      setPartial(payload.path)
      setErr(
        classifyCreateError(msg) === 'cancelled'
          ? '已取消创建。已经拉下来的部分还留在那台机器上 —— 可以在下面清掉,也可以到电脑上重新选这个文件夹继续。'
          : msg,
      )
    }
  }

  const cancelSetup = () => {
    void invoke(CH.workspaceCancelSetup, []).catch(() => {
      /* 取消本身失败没有第二条路可走;真正的结局由上面 create() 的 catch 说了算 */
    })
  }

  const discard = async () => {
    if (!partial) return
    try {
      await invoke(CH.workspaceDiscardPartial, [partial])
      setPartial(null)
      setErr(null)
    } catch (e) {
      setErr(`残件没清掉:${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (browsing) {
    return (
      <DirPicker
        onCancel={() => setBrowsing(false)}
        onPick={(path, entries) => {
          setParent(path)
          setParentNames(entries.filter((e) => e.dir).map((e) => e.name))
          setBrowsing(false)
        }}
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="新建工作区" sub="建在那台机器上" />
      </TopBar>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 44 }}>
          {!online ? (
            <Empty title="未连接" desc="工作区建在那台机器上 —— 连上主机才能建。" />
          ) : missing.length ? (
            // 决策 B-2:说清楚是哪一条,而不是留一个点下去才报错的亮按钮。
            <Empty
              title="这台主机做不了"
              desc={`它没有这些方法:${missing.join('、')}。多半是主机端版本旧了,升级它就有了。`}
            />
          ) : loading ? (
            <Empty title="正在读取主机上的项目和工作流…" />
          ) : loadErr ? (
            <Empty title="读不到主机上的清单" desc={loadErr} />
          ) : (
            <>
              {/* ───── 1 · 放哪儿 ───── */}
              <Sec right={<T mono style={[st.step, { color: c.faint }]}>1 / 3</T>}>放哪儿</Sec>
              <List>
                <Row onPress={busy ? undefined : () => setBrowsing(true)} disabled={busy}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T style={[st.rowTitle, { color: c.fg }]}>{parent ? '父目录' : '选一个父目录'}</T>
                    {parent ? (
                      // ★长路径是常态。从**头部**省略:尾巴那一段(你正要放进去的地方)才是要看的。
                      <T mono numberOfLines={1} ellipsizeMode="head" style={[st.path, { color: c.muted }]}>
                        {parent}
                      </T>
                    ) : (
                      <T style={[st.hint, { color: c.faint }]}>浏览那台机器上的目录</T>
                    )}
                  </View>
                  <T style={{ color: c.faint }}>›</T>
                </Row>
                <Field
                  value={name}
                  onChangeText={setName}
                  placeholder="工作区叫什么"
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  invalid={!!name.trim() && !nameOk}
                />
              </List>
              {/* 名字不合法时**当场**说明白 —— 这个字符串会变成那台机器上的一个目录名。 */}
              {name.trim() && !nameOk ? (
                <Note>{nameCheck.ok ? '' : nameCheck.reason}</Note>
              ) : fullPath ? (
                <View style={[st.pathBox, { borderColor: c.border, backgroundColor: c.bg2 }]}>
                  <T mono style={{ fontSize: 10.5, color: c.faint, marginBottom: 3 }}>会建出来的是</T>
                  {/* 完整路径原样摊开(可以换行)—— 「建到哪儿了」不该靠猜。 */}
                  <T mono style={{ fontSize: 12, lineHeight: 18, color: c.fg2 }}>{fullPath}</T>
                  {clash ? (
                    <T style={{ fontSize: 12, lineHeight: 18, color: c.warn, marginTop: 5 }}>
                      这个目录下已经有一个叫「{trimmed}」的文件夹了。继续的话会用它,而不是新建一个。
                    </T>
                  ) : null}
                </View>
              ) : (
                <Note>工作区那一层文件夹由主机自己建 —— 这里选的是「上一层」,不用先去建文件夹。</Note>
              )}

              {/* ───── 2 · 哪些项目 ───── */}
              {/* ★三段的右上角一律是**步号**。第一版这里放的是「0/3」计数,和隔壁的「3 / 3」
                  长得一模一样却是两个意思 —— 数量挪进 `note`(不大写的补充位)。 */}
              <Sec note={`选了 ${picked.size} / ${projects.length}`} right={<T mono style={[st.step, { color: c.faint }]}>2 / 3</T>}>
                哪些项目
              </Sec>
              {projects.length === 0 ? (
                <Note>这台主机上还没有注册任何 git 项目。注册项目留在电脑端。</Note>
              ) : (
                <>
                  {/* 三四十个项目是常态,不给搜索等于让人用手指滚 */}
                  {projects.length > 6 ? (
                    <List>
                      <Field
                        value={query}
                        onChangeText={setQuery}
                        placeholder="搜项目(名字 / 别名 / 仓库地址)"
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={{ fontSize: 14 }}
                      />
                    </List>
                  ) : null}
                  {shown.length === 0 ? (
                    <Note>没有匹配「{query}」的项目。</Note>
                  ) : (
                    <List>
                      {shown.map((p) => {
                        const on2 = picked.has(p.id)
                        return (
                          <View key={p.id}>
                            {/* ★选中态只靠勾选框,**不给整行铺靛蓝底** —— 多选全铺会变成一堵蓝墙,
                                而靛蓝是留给「你」和主动作的(同屏最多两次)。和 workflow.tsx 一致。 */}
                            <Row onPress={busy ? undefined : () => toggle(p.id)} disabled={busy}>
                              <View
                                style={[
                                  st.box,
                                  { borderColor: on2 ? c.accent : c.border2, backgroundColor: on2 ? c.accent : 'transparent' },
                                ]}
                              >
                                {on2 ? <T style={{ fontSize: 11, color: c.onAccent }}>✓</T> : null}
                              </View>
                              <View style={{ flex: 1, minWidth: 0 }}>
                                <T numberOfLines={1} style={[st.rowTitle, { color: c.fg }]}>
                                  {p.name}
                                  {p.alias ? <T style={{ color: c.faint }}>{`  ${p.alias}`}</T> : null}
                                </T>
                                {p.repoUrl ? (
                                  <T mono numberOfLines={1} ellipsizeMode="head" style={[st.sub, { color: c.muted }]}>
                                    {p.repoUrl}
                                  </T>
                                ) : null}
                              </View>
                            </Row>
                            {on2 ? (
                              <View style={{ paddingLeft: 30, paddingTop: 6 }}>
                                <T mono style={{ fontSize: 10.5, color: c.faint, marginBottom: 4 }}>分支</T>
                                <Field
                                  value={branchOf(p)}
                                  onChangeText={(v) => setBranchEdits((b) => ({ ...b, [p.id]: v }))}
                                  autoCapitalize="none"
                                  autoCorrect={false}
                                  editable={!busy}
                                  style={{ fontSize: 13.5 }}
                                />
                              </View>
                            ) : null}
                          </View>
                        )
                      })}
                    </List>
                  )}
                </>
              )}
              <Note>
                项目注册表就在主机上 —— 这里勾的就是主机那一份,没有「只在手机上加、不同步过去」这回事。
              </Note>

              {/* ───── 3 · 用哪个工作流 ───── */}
              <Sec right={<T mono style={[st.step, { color: c.faint }]}>3 / 3</T>}>用哪个工作流</Sec>
              {workflows.length === 0 ? (
                <Note>这台主机上一个工作流都没有。新建工作流留在电脑端。</Note>
              ) : (
                <List>
                  {workflows.map((w) => {
                    const on2 = w.id === flowId
                    return (
                      // 单选,只会亮一条 —— 这一组可以铺底(和 workflow.tsx 的工作流组同一个理由)。
                      <Row
                        key={w.id}
                        onPress={busy ? undefined : () => setFlowId(w.id)}
                        disabled={busy}
                        style={on2 ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}
                      >
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T style={[st.rowTitle, { color: c.fg }]}>{w.name}</T>
                          {/* 只显示阶段名。提示词和 provider 配置没有任何理由出现在这一屏。 */}
                          <T numberOfLines={2} style={[st.sub, { color: c.muted }]}>
                            {stageLabels(w, stageDefs).join(' → ') || '没有阶段'}
                          </T>
                        </View>
                        {on2 ? <T style={{ color: c.accent }}>✓</T> : null}
                      </Row>
                    )
                  })}
                </List>
              )}
              <Note>阶段、提示词、每阶段的代理都在电脑上改 —— 手机上只选一个现成的。</Note>

              {/* ───── 建 ───── */}
              <View style={{ height: 20 }} />
              <List>
                {busy ? (
                  <View style={[st.progBox, { borderColor: c.border2, backgroundColor: c.bg2 }]}>
                    <ActivityIndicator size="small" color={c.accent} />
                    <T numberOfLines={2} style={{ flex: 1, fontSize: 13, lineHeight: 19, color: c.fg2 }}>
                      {progress ?? '正在建立工作区…'}
                    </T>
                  </View>
                ) : null}
                {err ? (
                  // 报错用边框不用实底:实底彩色块全屏只留给权限门。
                  <View style={[st.errBox, { borderColor: c.permFullBorder, backgroundColor: c.bg2 }]}>
                    <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{err}</T>
                  </View>
                ) : null}
                {blocked && !busy ? <T style={[st.hint, { color: c.faint, paddingHorizontal: 2 }]}>{blocked}</T> : null}
                <Btn kind="pri" block onPress={() => void create()} disabled={!!blocked}>
                  {busy ? '创建中…' : '创建工作区'}
                </Btn>
                {busy ? (
                  methods.has(CH.workspaceCancelSetup) ? (
                    <Btn kind="ghost" block onPress={cancelSetup}>
                      取消创建
                    </Btn>
                  ) : (
                    <T style={[st.hint, { color: c.faint, textAlign: 'center' }]}>这台主机不支持中途取消,只能等它跑完。</T>
                  )
                ) : (
                  <Pressable onPress={() => goBack()} style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <T style={{ fontSize: 13.5, color: c.muted }}>返回</T>
                  </Pressable>
                )}
              </List>

              {/* ★残件这一块**刻意隔开、放在主按钮下面**:它是 danger,而这个仓库的规矩是
                  破坏性动作不与主动作相邻(§7.2 的「断开 / 清除本地数据」同一条)。
                  第一版把它直接摞在「创建工作区」上面,两颗键中间只有 8px。 */}
              {partial && !busy ? (
                <>
                  <View style={{ height: 22 }} />
                  <Sec>没建完的残件</Sec>
                  <List>
                    <T mono numberOfLines={2} ellipsizeMode="head" style={[st.path, { color: c.muted }]}>
                      {partial}
                    </T>
                    {methods.has(CH.workspaceDiscardPartial) ? (
                      <Btn kind="danger" block onPress={() => void discard()}>
                        清掉这个半成品
                      </Btn>
                    ) : (
                      <T style={[st.hint, { color: c.faint }]}>这台主机没有 workspace:discard-partial,只能到电脑上清。</T>
                    )}
                  </List>
                  <Note>它还留在那台机器上。清掉是删目录,清完这次创建就一点痕迹都不剩了。</Note>
                </>
              ) : null}

              <Note>
                创建是真的去 clone,项目多的时候要等一会儿,中途也可能失败 ——
                失败了这一屏会把原话贴出来,不会只是转个圈就没了。
              </Note>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

/**
 * 服务端目录浏览器。整屏顶掉表单(而不是弹一层 Modal):这一层的状态全在外面那个组件里,
 * 回来时一个字都不会丢,而且返回键的行为只有一种。
 *
 * ★`listDir` 的失败**是回一个 `error` 字段,不是抛**(没权限的目录是常态,见 `fs/browse.ts`)——
 *  只 `catch` 不看 `error` 的话,点进 `/root` 会得到一个空目录,看着像「这儿什么都没有」。
 */
function DirPicker({
  onCancel,
  onPick,
}: {
  onCancel: () => void
  onPick: (path: string, entries: BrowseEntry[]) => void
}) {
  const c = useC()
  const { invoke } = useConn()
  const [roots, setRoots] = useState<BrowseEntry[]>([])
  const [cur, setCur] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)

  const go = useCallback(
    async (path: string) => {
      setLoading(true)
      setFatal(null)
      try {
        const r = (await invoke(CH.fsBrowse, [{ path }])) as BrowseResult
        setCur(r)
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e))
      }
      setLoading(false)
    },
    [invoke],
  )

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const rs = (await invoke(CH.fsBrowseRoots, [])) as BrowseEntry[]
        if (alive) setRoots(rs ?? [])
      } catch {
        // 起点列表拿不到不致命 —— 下面那次 fs:browse('') 会落在家目录上,照样能走。
      }
    })()
    void go('') // 空路径 = 主机的家目录(listDir 自己兜的)
    return () => {
      alive = false
    }
  }, [invoke, go])

  const dirs = orderBrowseDirs(cur?.entries ?? [])

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={onCancel}>‹</IconBtn>}>
        <TopTitle title="选一个父目录" sub="工作区会建在它下面" />
      </TopBar>

      <View style={st.crumb}>
        {/* 长路径:从头部省略,尾巴(当前在哪儿)必须看得见 */}
        <T mono numberOfLines={1} ellipsizeMode="head" style={{ flex: 1, fontSize: 12, color: c.fg2 }}>
          {cur?.path ?? '…'}
        </T>
        {loading ? <ActivityIndicator size="small" color={c.accent} /> : null}
      </View>

      {roots.length ? (
        <View style={st.roots}>
          {roots.map((r) => (
            <Chip key={r.path} onPress={() => void go(r.path)}>
              {r.name}
            </Chip>
          ))}
        </View>
      ) : null}

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {fatal ? (
          <View style={[st.errBox, { borderColor: c.permFullBorder, backgroundColor: c.bg2, margin: 15 }]}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{fatal}</T>
          </View>
        ) : null}
        {cur?.error ? (
          // 服务端明说了读不了(多半是没权限)。原话贴出来,别装成空目录 ——
          // 而且要用报错的样子,不能用 Note 那种灰提示:它在截图里跟一句「小贴士」分不出来。
          <View style={[st.errBox, { borderColor: c.permFullBorder, backgroundColor: c.bg2, margin: 15 }]}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{cur.error}</T>
          </View>
        ) : null}
        <List>
          {cur?.parent ? (
            <Row tree onPress={() => void go(cur.parent!)}>
              <T style={{ fontSize: 14, color: c.muted }}>‹ 上一层</T>
            </Row>
          ) : null}
          {dirs.map((e) => (
            <Row key={e.path} tree onPress={() => void go(e.path)}>
              <T style={{ fontSize: 13.5, color: c.faint }}>▸</T>
              <T numberOfLines={1} style={{ flex: 1, fontSize: 14, color: c.fg }}>
                {e.name}
              </T>
            </Row>
          ))}
          {!loading && !cur?.error && dirs.length === 0 ? (
            <T style={[st.hint, { color: c.faint, paddingVertical: 10 }]}>这个目录下面没有子目录。放这儿也行。</T>
          ) : null}
        </List>
      </ScrollView>

      <View style={[st.foot, { borderTopColor: c.border, backgroundColor: c.bg }]}>
        {/* ★读不了的目录**不许选**。第一版这颗键在 `/root` 上照样是亮的,选完一路走到最后
            才在 clone 那一步炸 —— 正是「一个点了才报错的亮按钮」。 */}
        {cur?.error ? (
          <T style={[st.hint, { color: c.faint, textAlign: 'center', paddingBottom: 8 }]}>
            这个目录读不了,不能放在这儿。
          </T>
        ) : null}
        <Btn kind="pri" block onPress={() => cur && onPick(cur.path, cur.entries)} disabled={!cur || !!cur.error}>
          就放这儿
        </Btn>
      </View>
    </View>
  )
}

const st = StyleSheet.create({
  step: { fontSize: 10.5 },
  rowTitle: { fontSize: 14.5, fontWeight: '600' as const },
  sub: { fontSize: 11.5, marginTop: 3 },
  path: { fontSize: 11.5, marginTop: 3 },
  hint: { fontSize: 12 },
  box: { width: 20, height: 20, borderRadius: RADIUS.chip, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  errBox: { padding: 11, borderRadius: RADIUS.field, borderWidth: 1 },
  progBox: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 11, borderRadius: RADIUS.field, borderWidth: 1 },
  pathBox: { marginHorizontal: 15, marginTop: 8, padding: 11, borderRadius: RADIUS.field, borderWidth: StyleSheet.hairlineWidth },
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 15, paddingVertical: 9 },
  roots: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 15, paddingBottom: 8 },
  foot: { paddingHorizontal: 15, paddingTop: 10, paddingBottom: 26, borderTopWidth: StyleSheet.hairlineWidth },
})
