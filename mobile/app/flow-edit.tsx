import { useEffect, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { goBack } from '../src/nav'
import { CH } from '../../src/main/ipc/channels'
import { useC } from '../src/theme/theme'
import { Btn, Empty, Field, IconBtn, List, Note, Pill, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useLaunchOptions, useStageCatalog } from '../src/data/useWorkflow'
import { useAgents } from '../src/data/useAgents'
import { Sheet } from '../src/ui/Sheet'
import { confirmDestructive } from '../src/ui/confirmDestructive'
import {
  addStage, draftFromFlow, isDirty, moveStage, removeStage, saveBlocker, setName, setStageAgent,
  toggleGate, toWorkflowEdit, type CatalogStage, type FlowDraft,
} from '../src/data/flowDraft'

/**
 * 改这个工作区的工作流本身 —— 新建 / 改名 / 加删阶段 / 调顺序 / 每阶段用哪个代理 / 要不要停下来确认。
 *
 * ★★和启动屏(`workflow.tsx`)是**两件事**,这是这一屏最容易被误解的地方:
 *  · 启动屏改的是**这一次**,跑完就没了;
 *  · 这一屏改的是**工作流本身**,存回主机的 workspace.json,以后每次都这么跑。
 *  所以顶上那句话不是装饰,它是这一屏和上一屏唯一的区别标识。
 *
 * ★用户原话:「手机端支持新增就更好了,但是新增的需要同步到电脑端,否则电脑端没有配置信息,
 *  不知道怎么执行呢」。所以动的是**工作区自己那份** `ws.workflows` —— 它就是启动屏列的、
 *  也是真跑起来用的那一份,存完电脑端立刻看得见。改全局模板(设置 → 工作流)达不到这个效果:
 *  那份不会出现在一个已经建好的工作区的列表里。
 *
 * ★手机上**只放看得懂、改错了也看得出来**的那几样。提示词、CR 视角、权限档、hooks 不给改:
 *  一屏塞不下,而且改错了每一轮都受影响。主机端按「合并」存正是为了这个 —— 手机没发的字段
 *  一个都不许丢(见 `main/workspace/editWorkflows.ts` 顶上的注释)。
 */
export default function FlowEdit() {
  const c = useC()
  const { invoke, online, methods } = useConn()
  const { selected, wsName } = useStore()
  const { flow: flowParam } = useLocalSearchParams<{ flow?: string }>()
  const flowId = flowParam ?? ''

  const { workflows, loading, error } = useLaunchOptions(selected?.wsPath ?? null)
  const { builtin, custom } = useStageCatalog()
  const { agents } = useAgents()

  const original = useMemo(
    () => draftFromFlow(flowId ? workflows.find((w) => w.id === flowId) ?? null : null),
    [workflows, flowId],
  )
  const [draft, setDraft] = useState<FlowDraft>(original)
  // 列表拉回来之前 original 是空的;拉回来那一刻把草稿播种进去。★只在「还没动过」时播 ——
  // 否则一次后台刷新就会把人正在改的东西冲掉。
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (!touched) setDraft(original)
  }, [original, touched])

  const edit = (fn: (d: FlowDraft) => FlowDraft) => {
    setTouched(true)
    setDraft(fn)
  }

  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState<string | null>(null)   // 正在给哪个阶段挑代理
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const others = workflows.filter((w) => w.id !== flowId).map((w) => w.name)
  const blocker = saveBlocker(draft, others)
  const dirty = isDirty(draft, original)
  const isNew = !flowId

  const save = async () => {
    if (!selected || blocker) return
    setBusy(true)
    setErr(null)
    try {
      await invoke(CH.workspaceSaveWorkflow, [{ workspacePath: selected.wsPath, workflow: toWorkflowEdit(draft) }])
      goBack()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const del = async () => {
    if (!selected || isNew) return
    const ok = await confirmDestructive({
      title: `删除「${original.name}」`,
      message: '这条工作流会从这个工作区里删掉,电脑端也一起没了。已经跑过的记录不受影响。',
      confirmLabel: '删除',
    })
    if (!ok) return
    setBusy(true)
    setErr(null)
    try {
      await invoke(CH.workspaceDeleteWorkflow, [{ workspacePath: selected.wsPath, workflowId: flowId }])
      goBack()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const used = new Set(draft.stages.map((s) => s.key))

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title={isNew ? '新建工作流' : '编辑工作流'} sub={selected ? wsName(selected.wsPath) : ''} />
      </TopBar>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
          {!online ? (
            <Empty title="未连接" desc="工作流存在那台机器上,连上才能改。" />
          ) : !methods.has(CH.workspaceSaveWorkflow) ? (
            // 深链 / 老主机:上一屏已经不给入口了,这儿再兜一道,别让人改半天才发现存不下去。
            <Empty title="这台主机不支持" desc="那台机器上的 myFlowForge 版本还没有改工作流这条通道,升级一下就有了。" />
          ) : !selected ? (
            <Empty title="先选一个会话" desc="工作流是这个工作区的配置。" />
          ) : loading ? (
            <Empty title="正在读取…" />
          ) : error ? (
            <Empty title="读不到这个工作区" desc={error} />
          ) : !isNew && workflows.length > 0 && !workflows.some((w) => w.id === flowId) ? (
            <Empty title="这条工作流不在了" desc="可能刚在电脑端被删掉了。返回上一屏看看剩下哪些。" />
          ) : (
            <>
              {/* ★这句话是这一屏和启动屏唯一的区别标识,必须在界面上,不能只写在注释里。 */}
              <Note>改的是工作流本身,存下去以后每次都这么跑,电脑端同步生效。只想改这一次的话,回上一屏在启动前改。</Note>

              <Sec>名字</Sec>
              <List>
                <Field
                  value={draft.name}
                  onChangeText={(v) => edit((d) => setName(d, v))}
                  placeholder="比如:只开发不写测试"
                  autoFocus={isNew}
                />
              </List>

              <Sec right={<T mono style={{ fontSize: 10.5, color: c.faint }}>{draft.stages.length} 个阶段</T>}>
                流程
              </Sec>
              {draft.stages.length === 0 ? (
                <Note>还没有阶段。往下点「加一个阶段」。</Note>
              ) : (
                <List>
                  {draft.stages.map((s, i) => (
                    <View key={s.key} style={[st.stage, { borderBottomColor: c.border }]}>
                      <View style={st.head}>
                        <T mono style={{ fontSize: 11, color: c.faint, width: 18 }}>{i + 1}</T>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{s.name}</T>
                          {s.desc ? (
                            <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }}>{s.desc}</T>
                          ) : null}
                        </View>
                        {/* 顺序就是工作流本身,所以挪动放在最显眼的位置。★到头了就置灰,
                            而不是点了没反应 —— 那是「按钮坏了」最常见的误会。 */}
                        <IconBtn label="上移" disabled={i === 0} onPress={() => edit((d) => moveStage(d, i, -1))}>↑</IconBtn>
                        <IconBtn label="下移" disabled={i === draft.stages.length - 1} onPress={() => edit((d) => moveStage(d, i, 1))}>↓</IconBtn>
                        <IconBtn label="删除" onPress={() => edit((d) => removeStage(d, s.key))}>✕</IconBtn>
                      </View>

                      <View style={st.opts}>
                        <Pressable onPress={() => setPick(s.key)} style={[st.chip, { borderColor: c.border2 }]}>
                          <T mono style={{ fontSize: 11.5, color: c.fg2 }}>
                            {s.provider || '选代理'}{s.model ? ` · ${s.model}` : ''}
                          </T>
                          <T style={{ fontSize: 11, color: c.faint }}>改</T>
                        </Pressable>
                        <Pressable
                          onPress={() => edit((d) => toggleGate(d, s.key))}
                          style={[st.chip, { borderColor: s.gate ? c.pillGateBorder : c.border2 }]}
                        >
                          <T style={{ fontSize: 11.5, color: s.gate ? c.gate : c.muted }}>
                            {s.gate ? '跑完停下来等确认' : '跑完直接进下一步'}
                          </T>
                        </Pressable>
                        {/* 这两个标记由主机给,手机上不给改 —— 见 `@shared/launchStages`:
                            代码开发天生按项目扇出,技术方案必须产出唯一一份文档。 */}
                        {s.code ? <Pill tone="acc">按项目跑</Pill> : null}
                        {s.producesDoc ? <Pill tone="idle">出文档</Pill> : null}
                      </View>
                    </View>
                  ))}
                </List>
              )}

              <View style={{ height: 8 }} />
              <List>
                <Btn kind="ghost" block onPress={() => setAdding(true)}>加一个阶段</Btn>
              </List>

              <View style={{ height: 20 }} />
              <List>
                {err ? (
                  <View style={[st.errBox, { borderColor: c.permFullBorder, backgroundColor: c.bg2 }]}>
                    <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{err}</T>
                  </View>
                ) : blocker ? (
                  // 拦的理由和「按钮灰不灰」是同一个判断(`saveBlocker`),不会出现灰着但没说为什么。
                  <T style={{ fontSize: 12, color: c.faint, paddingHorizontal: 2 }}>{blocker}</T>
                ) : null}
                <Btn kind="pri" block onPress={save} disabled={!!blocker || busy || (!dirty && !isNew)}>
                  {busy ? '保存中…' : dirty || isNew ? '保存' : '没有改动'}
                </Btn>
                {!isNew ? (
                  <Pressable onPress={del} disabled={busy} style={{ alignItems: 'center', paddingVertical: 12 }}>
                    <T style={{ fontSize: 13.5, color: c.err }}>删除这条工作流</T>
                  </Pressable>
                ) : null}
              </List>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* 加阶段。★已经在这条流程里的置灰(同 key 跑起来会撞 id),而不是点了没反应。 */}
      <Sheet open={adding} onClose={() => setAdding(false)} title="加一个阶段" sub="加在流程最后,再用 ↑ 挪位置。">
        {builtin.length === 0 && custom.length === 0 ? (
          <Empty title="读不到阶段清单" desc="连接不稳时会这样。返回重进一次。" />
        ) : (
          <>
            <CatalogGroup
              title="内置阶段"
              items={builtin}
              used={used}
              onPick={(s) => { edit((d) => addStage(d, s)); setAdding(false) }}
            />
            {custom.length ? (
              <CatalogGroup
                title="自定义阶段库"
                items={custom}
                used={used}
                onPick={(s) => { edit((d) => addStage(d, s)); setAdding(false) }}
              />
            ) : null}
          </>
        )}
      </Sheet>

      {/* 挑代理。和启动屏那张单子同一套写法,只是这次改的是工作流本身。 */}
      <Sheet open={!!pick} onClose={() => setPick(null)} title="这个阶段用什么" sub="这台主机上装了的。存下去以后每次都用它。">
        {agents.length === 0 ? (
          <Empty title="这台机器上没探测到代理" desc="在电脑端的设置里检查 CLI 是否装好。" />
        ) : (
          agents.map((a) => (
            <View key={a.id} style={{ gap: 6, marginBottom: 10 }}>
              <T mono style={{ fontSize: 10.5, letterSpacing: 0.8, color: c.faint, textTransform: 'uppercase' }}>
                {a.displayName}
              </T>
              {a.models.map((mm) => (
                <Row
                  key={a.id + mm.id}
                  onPress={() => {
                    if (pick) edit((d) => setStageAgent(d, pick, { provider: a.id, model: mm.id }))
                    setPick(null)
                  }}
                >
                  <T style={{ fontSize: 14, color: c.fg }}>{mm.label}</T>
                </Row>
              ))}
            </View>
          ))
        )}
      </Sheet>
    </View>
  )
}

function CatalogGroup({
  title, items, used, onPick,
}: {
  title: string
  items: CatalogStage[]
  used: Set<string>
  onPick: (s: CatalogStage) => void
}) {
  const c = useC()
  return (
    <View style={{ gap: 6, marginBottom: 10 }}>
      <T mono style={{ fontSize: 10.5, letterSpacing: 0.8, color: c.faint, textTransform: 'uppercase' }}>{title}</T>
      {items.map((s) => {
        const on = used.has(s.key)
        return (
          <Row key={(s.libId ?? '') + s.key} disabled={on} onPress={() => onPick(s)}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 14, color: c.fg }}>{s.name}</T>
              {s.desc ? <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }}>{s.desc}</T> : null}
            </View>
            <T mono style={{ fontSize: 11, color: on ? c.faint : c.muted }}>{on ? '已在流程里' : s.provider}</T>
          </Row>
        )
      })}
    </View>
  )
}

const st = StyleSheet.create({
  stage: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  opts: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingLeft: 18 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
  },
  errBox: { padding: 11, borderRadius: 12, borderWidth: 1 },
})
