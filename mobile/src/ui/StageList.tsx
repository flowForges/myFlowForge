import { Pressable, StyleSheet, View } from 'react-native'
import { useC } from '../theme/theme'
import { List, Pill, Sec, T } from './kit'
import type { StageInfo } from '../data/useWorkflow'
import { stageAllowsAgentPick, stageAllowsPerProject, stageFansOut, type StageDrafts } from '../data/stageChoices'

/**
 * 启动工作流时的「流程」那一节:看得见每个阶段,并且能**为这一次**改。
 *
 * ★★2026-09-04 之前手机上这一节**根本不存在** —— 启动屏只让你选一条工作流的名字,
 *  连它有哪几步都看不见,更别说改代理。用户原话:「工作流应该有流程,然后每个阶段设计哪些
 *  代码项目,然后每个流程里用什么模型,都是可以选择的,现在好像都没有对吧」。是,都没有。
 * ★服务端其实一直支持(`LaunchStartConfig.stages`),缺的只是手机不发。所以这一节不是新造能力,
 *  是把已有的能力接出来 —— 也因此它和电脑端启动门发的是**同一种**结构。
 * ★**只改这一次**:工作流本身一个字节不动,下次启动回到默认。这句话写在小节副标题上,
 *  不是只写在注释里 —— 一个能改配置的界面和一个只改这次的界面,用起来是两回事。
 */
export function StageList({
  stages, drafts, projects, onToggle, onPickAgent, onPerProject, onPickProjectAgent, onAll,
}: {
  stages: StageInfo[]
  drafts: StageDrafts
  /** 这次选中的项目(逐项目那几行只列这些)。 */
  projects: { name: string; provider: string; model: string }[]
  onToggle: (key: string) => void
  onPickAgent: (key: string) => void
  onPerProject: (key: string, v: boolean) => void
  onPickProjectAgent: (key: string, project: string) => void
  onAll: (enabled: boolean) => void
}) {
  const c = useC()
  const st = styles(c)
  if (!stages.length) return null
  const onCount = stages.filter((s) => drafts[s.key]?.enabled ?? true).length

  return (
    <>
      <Sec
        right={
          <Pressable onPress={() => onAll(onCount !== stages.length)} hitSlop={8}>
            <T style={{ fontSize: 12, color: c.accent }}>{onCount === stages.length ? '全关' : '全开'}</T>
          </Pressable>
        }
      >
        {`流程 · ${onCount === stages.length ? `${stages.length} 个阶段` : `${onCount}/${stages.length} 个阶段`}`}
      </Sec>
      {/* ★这句必须在界面上,不能只在代码里:它回答「我改了会不会把工作流改坏」。 */}
      <T style={[st.hint, { color: c.faint }]}>只改这一次。工作流本身不变,下次启动回到默认。</T>
      <List>
        {stages.map((s) => {
          const d = drafts[s.key]
          const on = d?.enabled ?? true
          const fansOut = stageFansOut(s, drafts)
          const canPickAgent = stageAllowsAgentPick(s)
          const canToggleScope = stageAllowsPerProject(s)
          return (
            <View key={s.key} style={[st.stage, { borderBottomColor: c.border }]}>
              <Pressable onPress={() => onToggle(s.key)} style={st.head} hitSlop={4}>
                <View style={[st.box, { borderColor: on ? c.accent : c.border2, backgroundColor: on ? c.accent : 'transparent' }]}>
                  {on ? <T style={{ fontSize: 11, color: c.onAccent }}>✓</T> : null}
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T style={{ fontSize: 14.5, fontWeight: '600', color: on ? c.fg : c.faint }}>{s.name}</T>
                  {s.desc ? (
                    <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }}>{s.desc}</T>
                  ) : null}
                </View>
                {/* 门:这个阶段会停下来等人。不说的话,手机上会以为它卡住了。 */}
                {s.gate ? <Pill tone="gate">要确认</Pill> : null}
              </Pressable>

              {on ? (
                <View style={{ gap: 6, paddingLeft: 28 }}>
                  {/* ① 单代理 ⇄ 按项目。只给可切的阶段 —— 判定和发出去的那一份是同一个函数
                      (`@shared/launchStages`),不然会把代码开发的扇出压成单代理。 */}
                  {canToggleScope ? (
                    <View style={[st.seg, { borderColor: c.border2 }]}>
                      {([false, true] as const).map((v) => {
                        const sel = (d?.perProject ?? false) === v
                        return (
                          <Pressable
                            key={String(v)}
                            onPress={() => onPerProject(s.key, v)}
                            style={[st.segBtn, sel && { backgroundColor: c.accentDim }]}
                          >
                            <T style={{ fontSize: 12, color: sel ? c.accent : c.muted }}>{v ? '按项目' : '单代理'}</T>
                          </Pressable>
                        )
                      })}
                    </View>
                  ) : null}

                  {/* ② 阶段级代理。code 阶段没有 —— 它的代理来自下面那组逐项目选择。 */}
                  {canPickAgent && !fansOut ? (
                    <Pressable onPress={() => onPickAgent(s.key)} style={[st.chip, { borderColor: c.border2 }]}>
                      <T mono style={{ fontSize: 11.5, color: c.fg2 }}>
                        {d?.provider || '选代理'}{d?.model ? ` · ${d.model}` : ''}
                      </T>
                      <T style={{ fontSize: 11, color: c.faint }}>改</T>
                    </Pressable>
                  ) : null}

                  {/* ③ 按项目跑的阶段:每个项目各自用哪个代理。 */}
                  {fansOut ? (
                    projects.length === 0 ? (
                      <T style={{ fontSize: 11.5, color: c.err }}>这个阶段按项目跑,但一个项目都没选</T>
                    ) : (
                      projects.map((p) => {
                        const ov = d?.projectAgents[p.name]
                        return (
                          <Pressable
                            key={p.name}
                            onPress={() => onPickProjectAgent(s.key, p.name)}
                            style={[st.chip, { borderColor: c.border2 }]}
                          >
                            <T style={{ fontSize: 12, color: c.fg2, flexShrink: 0 }}>{p.name}</T>
                            <T mono numberOfLines={1} style={{ fontSize: 11.5, color: ov ? c.accent : c.muted, flex: 1, textAlign: 'right' }}>
                              {/* ★没覆盖时显示的是**项目自己的**代理,而且标一句「跟项目」——
                                  显示成空白的话,人会以为这条没配、其实它有。 */}
                              {ov ? `${ov.provider} · ${ov.model}` : (p.provider ? `${p.provider}${p.model ? ` · ${p.model}` : ''}` : '跟项目')}
                            </T>
                            <T style={{ fontSize: 11, color: c.faint }}>改</T>
                          </Pressable>
                        )
                      })
                    )
                  ) : null}
                </View>
              ) : null}
            </View>
          )
        })}
      </List>
    </>
  )
}

const styles = (c: ReturnType<typeof useC>) =>
  StyleSheet.create({
    hint: { fontSize: 11.5, paddingHorizontal: 16, marginTop: -4, marginBottom: 6 },
    stage: { paddingVertical: 10, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 },
    head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    box: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
    seg: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden', alignSelf: 'flex-start' },
    segBtn: { paddingHorizontal: 11, paddingVertical: 4 },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
    },
  })
