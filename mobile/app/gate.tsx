import { useMemo, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { useC } from '../src/theme/theme'
import { Btn, Empty, Field, IconBtn, List, Note, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useWaited } from '../src/ui/GateCard'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'

/**
 * 选择题门 · 单独一层。
 *
 * 两种来源:
 *   - `questions`(claude 的 AskUserQuestion):一到四题,每题单选或多选。
 *     ★答案必须以 `{ 问题原文: [选项 label] }` 的形状回去 —— CLI 就是按问题原文回查的。
 *     只回一个 allow 而不带 answers,CLI 会拿空答案把工具跑完并合成
 *     "The user did not answer the questions.",模型当场停在「没等到回复」。
 *   - `ask`(委派子代理的 forge_ask):有选项就是单选,没选项就是纯自由输入。
 *
 * 两种都留「都不是,我自己写」的兜底。
 */
export default function GateScreen() {
  const c = useC()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const { online } = useConn()
  const { gates, answerGate, wsName, sessionTitle } = useStore()

  const gate = useMemo(() => gates.find((g) => g.id === id) ?? null, [gates, id])
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [free, setFree] = useState('')
  const [askPick, setAskPick] = useState<number>(-1)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const waited = useWaited(gate?.since ?? Date.now())

  // ★门被别人抢答了(电脑上的人先点了),这一层就该明说,不是静默退出 ——
  //  静默退出会让人以为是自己答的,而实际决定完全可能是相反的那个。
  if (!gate) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar left={<IconBtn onPress={() => router.back()}>‹</IconBtn>}>
          <TopTitle title="这道门已经没了" />
        </TopBar>
        <Empty
          title="已经被答掉了"
          desc={'可能是电脑上的人先答了,也可能代理自己撤回了这次请求。\n谁先答谁算数 —— 你这一票没有生效。'}
        />
        <View style={{ paddingHorizontal: 30 }}>
          <Btn block onPress={() => router.back()}>
            回对话
          </Btn>
        </View>
      </View>
    )
  }

  const qs = gate.questions ?? []
  const multiQuestion = gate.kind === 'questions' && qs.length > 0

  const toggle = (q: string, label: string, multi: boolean) => {
    setPicked((p) => {
      const cur = p[q] ?? []
      if (!multi) return { ...p, [q]: [label] }
      return { ...p, [q]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] }
    })
  }

  const answered = multiQuestion
    ? qs.every((q) => (picked[q.question] ?? []).length > 0)
    : gate.options?.length
      ? askPick >= 0
      : free.trim().length > 0

  const submit = async () => {
    setBusy(true)
    setErr(null)
    try {
      if (multiQuestion) {
        await answerGate(gate, {
          decision: 'allow',
          answers: picked,
          response: free.trim() || undefined,
        })
      } else {
        await answerGate(gate, {
          decision: 'allow',
          choice: askPick >= 0 ? askPick : undefined,
          response: free.trim() || undefined,
        })
      }
      router.back()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const canSubmit = online && !busy && (answered || free.trim().length > 0)

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar tint={c.gateDim} left={<IconBtn onPress={() => router.back()}>‹</IconBtn>}>
        <TopTitle
          tint={c.gate}
          title="代理在问你"
          sub={`${wsName(gate.wsPath)} · ${sessionTitle(gate.wsPath, gate.sessionId)} · 等待 ${waited}`}
        />
      </TopBar>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 30 }}>
          {multiQuestion ? (
            qs.map((q) => {
              const multi = !!q.multiSelect
              const cur = picked[q.question] ?? []
              return (
                <View key={q.question}>
                  <View style={{ paddingHorizontal: 15, paddingTop: 16 }}>
                    <T style={{ fontSize: 17, fontWeight: '600', lineHeight: 25, color: c.fg }}>{q.question}</T>
                    <T style={{ fontSize: 11.5, color: c.faint, marginTop: 6 }}>
                      {multi ? '多选 · 可以选好几个' : '单选'}
                    </T>
                  </View>
                  <View style={{ height: 10 }} />
                  <List>
                    {q.options.map((o) => {
                      const on = cur.includes(o.label)
                      return (
                        <Pressable
                          key={o.label}
                          onPress={() => toggle(q.question, o.label, multi)}
                          style={({ pressed }) => [
                            st.opt,
                            { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accentDim : c.surface },
                            pressed && { opacity: 0.85 },
                          ]}
                        >
                          <View
                            style={[
                              st.box,
                              { borderRadius: multi ? 6 : 999, borderColor: on ? c.accent : c.border2, backgroundColor: on ? c.accent : 'transparent' },
                            ]}
                          >
                            {on ? <T style={{ fontSize: 11, color: c.onAccent }}>✓</T> : null}
                          </View>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{o.label}</T>
                            {o.description ? (
                              <T style={{ fontSize: 12.5, lineHeight: 19, color: c.muted, marginTop: 3 }}>
                                {o.description}
                              </T>
                            ) : null}
                          </View>
                        </Pressable>
                      )
                    })}
                  </List>
                </View>
              )
            })
          ) : (
            <>
              <View style={{ paddingHorizontal: 15, paddingTop: 16 }}>
                <T style={{ fontSize: 17, fontWeight: '600', lineHeight: 25, color: c.fg }}>{gate.title}</T>
                {gate.agentName ? (
                  <T style={{ fontSize: 11.5, color: c.faint, marginTop: 6 }}>来自子代理 {gate.agentName}</T>
                ) : null}
              </View>
              <View style={{ height: 10 }} />
              {gate.options?.length ? (
                <List>
                  {gate.options.map((o, i) => {
                    const on = askPick === i
                    return (
                      <Pressable
                        key={`${o.t}-${i}`}
                        onPress={() => setAskPick(i)}
                        style={({ pressed }) => [
                          st.opt,
                          { borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accentDim : c.surface },
                          pressed && { opacity: 0.85 },
                        ]}
                      >
                        <View
                          style={[
                            st.box,
                            { borderRadius: 999, borderColor: on ? c.accent : c.border2, backgroundColor: on ? c.accent : 'transparent' },
                          ]}
                        >
                          {on ? <T style={{ fontSize: 11, color: c.onAccent }}>✓</T> : null}
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{o.t}</T>
                          {o.d ? (
                            <T style={{ fontSize: 12.5, lineHeight: 19, color: c.muted, marginTop: 3 }}>{o.d}</T>
                          ) : null}
                        </View>
                      </Pressable>
                    )
                  })}
                </List>
              ) : null}
            </>
          )}

          <Sec>{gate.options?.length || multiQuestion ? '都不是' : '你的回答'}</Sec>
          <List>
            <Field
              value={free}
              onChangeText={setFree}
              placeholder="我自己写一个方案给它…"
              multiline
              style={{ minHeight: 68 }}
            />
          </List>
          {multiQuestion ? (
            <Note>每道题都要选一个才能提交;补充说明可留可不留。</Note>
          ) : null}
        </ScrollView>

        <View style={[st.foot, { backgroundColor: c.surface, borderTopColor: c.border }]}>
          {/* ★提示挨着按钮。放页顶等于用户滚动后看不见,现象就是「点了没反应」。 */}
          {!online ? (
            <T style={{ fontSize: 12, color: c.err, paddingHorizontal: 12, paddingBottom: 8 }}>
              未连接 · 答不了。恢复连接后这道门还在。
            </T>
          ) : err ? (
            <T style={{ fontSize: 12, color: c.err, paddingHorizontal: 12, paddingBottom: 8 }}>{err}</T>
          ) : !canSubmit ? (
            <T style={{ fontSize: 12, color: c.faint, paddingHorizontal: 12, paddingBottom: 8 }}>
              {multiQuestion ? '每道题选一个,或者在下面自己写一句' : '选一个,或者在下面自己写一句'}
            </T>
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
            <Btn kind="ghost" onPress={() => router.back()}>
              稍后
            </Btn>
            <Btn kind="pri" style={{ flex: 1 }} onPress={submit} disabled={!canSubmit}>
              {busy ? '提交中…' : '提交答案'}
            </Btn>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const st = StyleSheet.create({
  opt: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingHorizontal: 13,
    paddingVertical: 12,
    borderRadius: 13,
    borderWidth: StyleSheet.hairlineWidth,
  },
  box: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  foot: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10 },
})
