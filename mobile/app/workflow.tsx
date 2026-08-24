import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../src/main/ipc/channels'
import { useC } from '../src/theme/theme'
import { Btn, Empty, Field, IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useLaunchOptions } from '../src/data/useWorkflow'

/**
 * 启动工作流。
 *
 * 手机上只能**选择并启动已有工作流** —— 不做编辑器(阶段 / 每阶段提示词 / hooks / provider 覆盖,
 * 在电脑上就是一张复杂表单;搬到手机成本极高、频率极低、编错后果严重)。
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

  const [flowId, setFlowId] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
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
  const chosen = projects.filter((p) => picked.has(p.name))
  const ready = !!selected && !!flow && chosen.length > 0 && (seed.trim() || supplement.trim())

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
          // stages / hooks 一律不传 = 这个工作流的每个阶段都按它自己的默认代理跑。
          // 手机上没有勾选阶段的界面,传一个半成品的选择反而会静默丢掉阶段。
        },
      ])
      refresh()
      if (router.canGoBack()) router.back()
      else router.replace('/')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>‹</IconBtn>}>
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
                ) : !ready ? (
                  <T style={{ fontSize: 12, color: c.faint, paddingHorizontal: 2 }}>
                    {chosen.length === 0
                      ? '至少选一个项目'
                      : '先写一句「这次要做什么」—— 不说的话,阶段代理会自己猜一个需求出来跑。'}
                  </T>
                ) : null}
                <Btn kind="pri" block onPress={launch} disabled={!ready || busy}>
                  {busy ? '启动中…' : `启动${flow ? `「${flow.name}」` : ''}`}
                </Btn>
                <Pressable onPress={() => router.back()} style={{ alignItems: 'center', paddingVertical: 12 }}>
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
