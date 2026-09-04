import { useEffect, useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import { CH } from '../../src/main/ipc/channels'
import { useC } from '../src/theme/theme'
import { Btn, Empty, Field, IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useLaunchOptions } from '../src/data/useWorkflow'
import { useAgents } from '../src/data/useAgents'
import { StageList } from '../src/ui/StageList'
import { Sheet } from '../src/ui/Sheet'
import {
  initDrafts, launchBlocker, patchDraft, setStageProjectAgent, toStageChoices, type StageDrafts,
} from '../src/data/stageChoices'

/**
 * 启动工作流。
 *
 * ★★2026-09-04:加了「流程」那一节 —— 看得见每个阶段,并且能**为这一次**改(开关 / 阶段代理 /
 *  单代理⇄按项目 / 逐项目代理)。用户原话:「工作流应该有流程,然后每个阶段设计哪些代码项目,
 *  然后每个流程里用什么模型,都是可以选择的,现在好像都没有对吧」。是,都没有 —— 而服务端
 *  (`LaunchStartConfig.stages`)一直支持,缺的只是手机不发。所以这不是新造能力,是接出来。
 * ★**只改这一次**。工作流模板本身(阶段增删、提示词、hooks)仍然留在电脑端:
 *  那是一张会写回配置的表单,改坏了下次每一轮都受影响 —— 和「这一次这么跑」完全是两件事。
 *
 * ★服务端有一道硬门槛:`hasRequirement` —— 需求和补充说明**至少要有一句**,否则拒绝启动。
 *  理由是阶段代理只拿到一串项目名会自己猜一个需求出来跑一堆东西。所以这一屏把「这次要做什么」
 *  做成必填,并且在按钮旁边就说清楚,而不是让人点下去吃一句服务端报错。
 */
export default function WorkflowLaunch() {
  const c = useC()
  const { invoke, online } = useConn()
  const { selected, wsName, refresh } = useStore()
  const { workflows, projects, loading, error } = useLaunchOptions(selected?.wsPath ?? null)

  const { agents } = useAgents()
  const [flowId, setFlowId] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  /**
   * 逐阶段的临时草稿。★按**工作流 id** 重建 —— 切了工作流,上一条的阶段 key 一个都不适用了。
   *  不重建的话会出现「选了 B 工作流,发出去的却带着 A 的阶段选择」,而服务端只会安静地忽略,
   *  屏幕上完全看不出来。
   */
  const [drafts, setDrafts] = useState<StageDrafts>({})
  /** 正在给谁挑代理:阶段级(project 为空)还是某个阶段的某个项目。 */
  const [pick, setPick] = useState<{ stage: string; project?: string } | null>(null)
  const [seed, setSeed] = useState('')
  const [supplement, setSupplement] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 默认:第一个工作流 + 全部项目。用户改过就不再动。
  useEffect(() => {
    if (!flowId && workflows.length) setFlowId(workflows[0].id)
  }, [workflows, flowId])
  useEffect(() => {
    if (projects.length && picked.size === 0) setPicked(new Set(projects.map((p) => p.name)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects])

  const toggle = (name: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(name)) n.delete(name)
      else n.add(name)
      return n
    })

  const flow = workflows.find((w) => w.id === flowId) ?? null
  const stages = useMemo(() => flow?.stages ?? [], [flow])
  const chosen = projects.filter((p) => picked.has(p.name))

  // 换工作流 → 草稿整份重建成那条流程的默认值。
  useEffect(() => { setDrafts(initDrafts(stages)) }, [stages])

  const requirement = `${seed} ${supplement}`
  const blocker = launchBlocker(stages, drafts, chosen.map((p) => p.name), requirement)
  const ready = !!selected && !!flow && !blocker

  const launch = async () => {
    if (!selected || !flow) return
    setBusy(true)
    setErr(null)
    try {
      await invoke(CH.workflowEnter, [
        {
          workspacePath: selected.wsPath,
          workflowId: flow.id,
          projects: chosen.map((p) => ({ name: p.name, provider: p.provider, model: p.model })),
          supplement: supplement.trim(),
          seed: seed.trim(),
          sessionId: selected.sessionId,
          // ★「流程」那一节的逐阶段选择。结构和电脑端启动门发的**完全一样**
          //   (两边都走 `@shared/launchStages` 的 `buildStageChoice`),所以不可能各发各的。
          // ★hooks 仍然不传 = 全跑。手机上没有那一节,传半份等于静默关掉一些 hook。
          stages: toStageChoices(stages, drafts, chosen.map((p) => p.name)),
        },
      ])
      refresh()
      goBack()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => (goBack())}>‹</IconBtn>}>
        <TopTitle title="启动工作流" sub={selected ? wsName(selected.wsPath) : '未选会话'} />
      </TopBar>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
          {!online ? (
            <Empty title="未连接" desc="工作流跑在那台机器上,连上才能启动。" />
          ) : !selected ? (
            <Empty title="先选一个会话" desc="工作流是挂在会话上的。" />
          ) : loading ? (
            <Empty title="正在读取…" />
          ) : error ? (
            <Empty title="读不到这个工作区" desc={error} />
          ) : workflows.length === 0 ? (
            <Empty title="这个工作区还没有工作流" desc="新建和编辑工作流留在电脑端。" />
          ) : (
            <>
              <Sec>选一个工作流</Sec>
              <List>
                {workflows.map((w) => {
                  const on = w.id === flowId
                  return (
                    <Row
                      key={w.id}
                      onPress={() => setFlowId(w.id)}
                      style={on ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}
                    >
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{w.name}</T>
                      </View>
                      {on ? <T style={{ color: c.accent }}>✓</T> : null}
                    </Row>
                  )
                })}
              </List>

              <Sec right={<T mono style={{ fontSize: 10.5, color: c.faint }}>{chosen.length}/{projects.length}</T>}>
                在哪些项目上跑
              </Sec>
              {/* ★项目这一节在流程**上面**:逐项目那几行要按选中的项目来列,先选完项目再往下看
                  才不会看到一堆待会儿要消失的行。 */}
              {projects.length === 0 ? (
                <Note>这个工作区里没有项目。工作流没有可以开工的地方。</Note>
              ) : (
                <List>
                  {projects.map((p) => {
                    const on = picked.has(p.name)
                    return (
                      // ★选中态只靠勾选框,**不给整行铺靛蓝底** —— 默认全选时这一屏会变成一堵蓝墙,
                      //  而 D 版定的是「靛蓝只给你和主动作,同屏最多出现两次」。单选的工作流那一组
                      //  只会亮一条,铺底没问题;这一组是多选,不行。
                      <Row key={p.name} onPress={() => toggle(p.name)}>
                        <View
                          style={[
                            st.box,
                            { borderColor: on ? c.accent : c.border2, backgroundColor: on ? c.accent : 'transparent' },
                          ]}
                        >
                          {on ? <T style={{ fontSize: 11, color: c.onAccent }}>✓</T> : null}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{p.name}</T>
                          {p.provider ? (
                            <T mono style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                              {p.provider}
                              {p.model ? ` · ${p.model}` : ''}
                            </T>
                          ) : null}
                        </View>
                      </Row>
                    )
                  })}
                </List>
              )}

              <StageList
                stages={stages}
                drafts={drafts}
                projects={chosen}
                onToggle={(k) => setDrafts((d) => patchDraft(d, k, { enabled: !(d[k]?.enabled ?? true) }))}
                onPerProject={(k, v) => setDrafts((d) => patchDraft(d, k, { perProject: v }))}
                onPickAgent={(k) => setPick({ stage: k })}
                onPickProjectAgent={(k, project) => setPick({ stage: k, project })}
                onAll={(enabled) => setDrafts((d) => {
                  let next = d
                  for (const st of stages) next = patchDraft(next, st.key, { enabled })
                  return next
                })}
              />

              <Sec>这次要做什么</Sec>
              <List>
                <Field
                  value={seed}
                  onChangeText={(v) => {
                    setSeed(v)
                    if (err) setErr(null)
                  }}
                  placeholder="一句话说清楚。比如:给评论接口加分页,顺手补上单测。"
                  multiline
                  style={{ minHeight: 76 }}
                />
              </List>

              <Sec>补充说明(可选)</Sec>
              <List>
                <Field
                  value={supplement}
                  onChangeText={setSupplement}
                  placeholder="约束、坑、别动哪些文件…"
                  multiline
                  style={{ minHeight: 56 }}
                />
              </List>

              <View style={{ height: 20 }} />
              <List>
                {/* ★提示挨着按钮。这条正是服务端会拒绝的那一条,提前说清比吃一句报错强。 */}
                {err ? (
                  <View style={[st.errBox, { borderColor: c.permFullBorder, backgroundColor: c.bg2 }]}>
                    <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{err}</T>
                  </View>
                ) : blocker ? (
                  // ★拦的理由由 `launchBlocker` 一处给出 —— 界面上这句话和「按钮灰不灰」
                  //   是同一个判断,不会出现「按钮灰着但没说为什么」。
                  <T style={{ fontSize: 12, color: c.faint, paddingHorizontal: 2 }}>
                    {blocker === '先说一句这次要做什么'
                      ? '先写一句「这次要做什么」—— 不说的话,阶段代理会自己猜一个需求出来跑。'
                      : blocker}
                  </T>
                ) : null}
                <Btn kind="pri" block onPress={launch} disabled={!ready || busy}>
                  {busy ? '启动中…' : `启动${flow ? `「${flow.name}」` : ''}`}
                </Btn>
                <Pressable onPress={() => goBack()} style={{ alignItems: 'center', paddingVertical: 12 }}>
                  <T style={{ fontSize: 13.5, color: c.muted }}>取消</T>
                </Pressable>
              </List>

              <Note>
                启动后会停在第一个阶段和你对话,不会一口气跑完。每一步都要你点「下一步」才继续 ——
                真正开始改代码是在推进到执行阶段之后。
              </Note>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/*
        挑代理。★一张单子两用(阶段级 / 某阶段的某个项目)——两处要挑的是同一件东西
        (这台主机上装了哪个 CLI、哪个模型),做成两张只会各自跑偏。
        ★「跟项目」那一项只在逐项目那条路上出现:阶段级没有「跟项目」这个概念。
      */}
      <Sheet
        open={!!pick}
        onClose={() => setPick(null)}
        title={pick?.project ? `「${pick.project}」在这个阶段用什么` : '这个阶段用什么'}
        sub="这台主机上装了的。只影响这一次运行。"
      >
        {pick?.project ? (
          <Pressable
            onPress={() => {
              setDrafts((d) => setStageProjectAgent(d, pick.stage, pick.project!, null))
              setPick(null)
            }}
            style={{ paddingVertical: 10 }}
          >
            <T style={{ fontSize: 14, color: c.muted }}>跟项目走(用这个项目自己配的代理)</T>
          </Pressable>
        ) : null}
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
                    if (!pick) return
                    setDrafts((d) =>
                      pick.project
                        ? setStageProjectAgent(d, pick.stage, pick.project, { provider: a.id, model: mm.id })
                        : patchDraft(d, pick.stage, { provider: a.id, model: mm.id }),
                    )
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

const st = StyleSheet.create({
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errBox: { padding: 11, borderRadius: 12, borderWidth: 1 },
})
