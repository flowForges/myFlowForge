import { useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, permissionModeLabel, type PermissionMode } from '../../src/shared/permissions'
import { useC } from '../src/theme/theme'
import { Banner, Btn, Chip, Empty, Field, IconBtn, LiveDot, Row, T, TopBar } from '../src/ui/kit'
import { GateCard } from '../src/ui/GateCard'
import { Sheet } from '../src/ui/Sheet'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useChat } from '../src/data/useChat'
import { useAgents } from '../src/data/useAgents'

/**
 * 根视图 · 对话。
 *
 * 版式照原型设计层 D:顶栏(主机 / 会话切换 / 停止)→ 状态条 → 消息流 → **钉住的门** → 输入区。
 * 门在输入区正上方且不参与滚动 —— 那是这一屏唯一的实底彩色块。
 */
export default function Chat() {
  const c = useC()
  const insets = useSafeAreaInsets()
  const { activeHost, hosts, loading: hostsLoading, state, online, reconnect } = useConn()
  const { selected, gates, gatesFor, answerGate, wsName, sessionTitle, loading: storeLoading } = useStore()
  const { msgs, busy, send, stop, loading: chatLoading } = useChat(selected?.wsPath ?? null, selected?.sessionId ?? null)
  const { agents } = useAgents()

  const [text, setText] = useState('')
  const [agentSheet, setAgentSheet] = useState(false)
  const [permSheet, setPermSheet] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [perm, setPerm] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const flow = useRef<ScrollView | null>(null)

  // 代理探测回来之前不知道选谁,回来之后落到第一个装了的。用户改过就不再动它。
  useEffect(() => {
    if (agentId || !agents.length) return
    setAgentId(agents[0].id)
    setModelId(agents[0].models[0]?.id ?? null)
  }, [agents, agentId])

  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId])
  const model = useMemo(() => agent?.models.find((m) => m.id === modelId) ?? agent?.models[0] ?? null, [agent, modelId])

  const myGates = selected ? gatesFor(selected.wsPath, selected.sessionId) : []
  // 本会话没门,但别处有,就把别处那道拿过来钉着 —— 门比「我正在看哪个会话」重要。
  const shownGates = myGates.length ? myGates : gates
  const gate = shownGates[0] ?? null
  const gateElsewhere = gate != null && myGates.length === 0

  useEffect(() => {
    if (!msgs.length) return
    const t = setTimeout(() => flow.current?.scrollToEnd({ animated: true }), 30)
    return () => clearTimeout(t)
  }, [msgs.length])

  const doSend = async () => {
    const t = text.trim()
    if (!t || !selected || !agent) return
    setSending(true)
    try {
      await send({
        text: t,
        agent: agent.id,
        agentLabel: agent.displayName,
        model: model?.id ?? '',
        permissionMode: perm,
      })
      setText('')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }

  const answer = async (decision: 'allow' | 'deny') => {
    if (!gate) return
    try {
      await answerGate(gate, { decision })
      setNotice(decision === 'allow' ? '已允许 · 代理继续' : '已拒绝 · 代理换方案')
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  // ── 还没配主机:这一屏没有任何东西可画,直接把人送去配 ────────────────────────
  if (!hostsLoading && hosts.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar>
          <T style={{ fontSize: 15.5, fontWeight: '600', color: c.fg, paddingHorizontal: 2 }}>myFlowForge</T>
        </TopBar>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Empty
            title="先连一台电脑"
            desc={'手机端不在本地跑代理 —— 它是你电脑上那台 Forge 的遥控器。\n在电脑上跑起 daemon,把它打印的地址填进来。'}
          />
          <View style={{ paddingHorizontal: 30 }}>
            <Btn kind="pri" block onPress={() => router.push('/add-host')}>
              添加主机
            </Btn>
          </View>
        </View>
      </View>
    )
  }

  const tone = state?.status === 'ready' ? 'ok' : state?.status === 'connecting' ? 'wait' : 'off'

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        left={<IconBtn onPress={() => router.push('/hosts')}>🖥</IconBtn>}
        right={
          <IconBtn
            onPress={busy ? () => void stop() : undefined}
            tone={busy ? c.err : c.faint}
            disabled={!busy || !online}
          >
            ■
          </IconBtn>
        }
      >
        <Pressable onPress={() => router.push('/sessions')} style={{ paddingHorizontal: 2, paddingVertical: 2 }}>
          <T numberOfLines={1} style={{ fontSize: 15.5, fontWeight: '600', letterSpacing: -0.3, color: c.fg }}>
            {selected ? sessionTitle(selected.wsPath, selected.sessionId) : '选一个会话'}
            <T style={{ color: c.faint, fontSize: 12 }}> ▾</T>
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}>
            <LiveDot tone={tone} />
            <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, flexShrink: 1 }}>
              {activeHost?.label ?? '未选主机'}
              {selected ? ` · ${wsName(selected.wsPath)}` : ''}
            </T>
          </View>
        </Pressable>
      </TopBar>

      {/* 断线必须显式。绝不拿缓存假装在线。 */}
      {!online && state?.status !== 'connecting' ? (
        <Banner
          tone="off"
          action={
            <Btn size="sm" kind="ghost" onPress={reconnect}>
              重连
            </Btn>
          }
        >
          {state?.status === 'failed'
            ? state.error
            : state?.status === 'retrying'
              ? `已断开,${Math.round(state.nextInMs / 1000)} 秒后重连`
              : `未连接 ${activeHost?.label ?? ''}`}
        </Banner>
      ) : null}
      {state?.status === 'connecting' ? <Banner tone="wait">正在连接 {activeHost?.label ?? ''}…</Banner> : null}

      <ScrollView ref={flow} style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 10 }}>
        {!online ? null : storeLoading || chatLoading ? (
          <Empty title="正在读取…" />
        ) : !selected ? (
          <Empty title="选一个会话" desc="点顶部的会话名,或者去「全部会话」按工作区找。" />
        ) : msgs.length === 0 ? (
          <Empty title="这个会话还没有消息" desc="在下面给代理下达任务。" />
        ) : (
          msgs.map((m) =>
            m.who === 'user' ? (
              <View key={m.id} style={[st.you, { backgroundColor: c.accentDim, borderColor: c.youBorder }]}>
                <T style={{ fontSize: 15, lineHeight: 23, color: c.fg }}>{m.text}</T>
              </View>
            ) : (
              <View key={m.id} style={{ marginTop: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 6 }}>
                  <View style={[st.av, { backgroundColor: c.surface2, borderColor: c.border2 }]}>
                    <T style={{ fontSize: 10, fontWeight: '700', color: c.fg2 }}>
                      {(m.model ?? 'A').slice(0, 1).toUpperCase()}
                    </T>
                  </View>
                  <T mono style={{ fontSize: 11, letterSpacing: 0.4, color: c.faint }}>
                    {m.model ?? '代理'}
                  </T>
                </View>
                {m.think ? (
                  <T style={[st.think, { color: c.muted, borderLeftColor: c.border2 }]}>{m.think.slice(-400)}</T>
                ) : null}
                <T style={{ fontSize: 15, lineHeight: 25, color: c.fg2, paddingLeft: 26 }}>
                  {m.text}
                  {m.streaming ? <T style={{ color: c.accent }}>▍</T> : null}
                </T>
                {m.error ? (
                  <T style={{ fontSize: 12.5, color: c.err, paddingLeft: 26, marginTop: 6 }}>{m.error}</T>
                ) : null}
              </View>
            ),
          )
        )}
      </ScrollView>

      {/* ── 门:钉在输入区正上方,不参与滚动 ───────────────────────────────── */}
      {gate ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 6, backgroundColor: c.bg }}>
          {gateElsewhere ? (
            <Pressable
              onPress={() => router.push('/sessions')}
              style={{ paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <T style={{ fontSize: 11.5, color: c.gate }}>
                这道门来自另一个会话:{wsName(gate.wsPath)} · {sessionTitle(gate.wsPath, gate.sessionId)}
              </T>
            </Pressable>
          ) : null}
          <GateCard
            gate={gate}
            index={0}
            total={shownGates.length}
            online={online}
            where={`${wsName(gate.wsPath)} · ${sessionTitle(gate.wsPath, gate.sessionId)}`}
            onAllow={() => void answer('allow')}
            onDeny={() => void answer('deny')}
            onOpen={() => router.push({ pathname: '/gate', params: { id: gate.id } })}
          />
        </View>
      ) : null}

      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={{ paddingHorizontal: 14, paddingBottom: 6 }}>
          <T style={{ fontSize: 12, color: c.muted }}>{notice}(点一下关掉)</T>
        </Pressable>
      ) : null}

      {/* ── 输入区 ─────────────────────────────────────────────────────────── */}
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View
          style={[
            st.foot,
            { backgroundColor: c.surface, borderTopColor: c.border, paddingBottom: Math.max(6, insets.bottom) },
          ]}
        >
          <View style={st.entry}>
            <Field
              value={text}
              onChangeText={setText}
              placeholder={online ? '给代理下达任务…' : '未连接 · 发不出去'}
              multiline
              editable={online && !!selected}
              style={{ flex: 1, minHeight: 44, maxHeight: 108 }}
            />
            <Pressable
              onPress={doSend}
              disabled={!online || !selected || !text.trim() || sending}
              style={({ pressed }) => [
                st.send,
                { backgroundColor: c.accent, borderColor: c.accent },
                pressed && { opacity: 0.85 },
                (!online || !selected || !text.trim() || sending) && { opacity: 0.4 },
              ]}
            >
              <T style={{ fontSize: 17, color: c.onAccent }}>↑</T>
            </Pressable>
          </View>
          <View style={st.chips}>
            <Chip tone="on" onPress={online ? () => setAgentSheet(true) : undefined} disabled={!online}>
              {agent ? `${agent.displayName}${model ? ' · ' + model.label : ''}` : '选代理'}
            </Chip>
            <Chip
              tone={perm === 'full' ? 'full' : perm === 'readonly' ? 'readonly' : 'auto'}
              onPress={online ? () => setPermSheet(true) : undefined}
              disabled={!online}
            >
              {permissionModeLabel(perm)}
            </Chip>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Sheet open={agentSheet} onClose={() => setAgentSheet(false)} title="编码代理" sub="这台主机上真实装了的">
        {agents.length === 0 ? (
          <Empty title="这台机器上没探测到代理" desc="在电脑端的设置里检查 CLI 是否装好。" />
        ) : (
          agents.map((a) => (
            <View key={a.id} style={{ gap: 8 }}>
              <T mono style={{ fontSize: 10.5, letterSpacing: 0.8, color: c.faint, textTransform: 'uppercase' }}>
                {a.displayName}
              </T>
              {a.models.map((mm) => {
                const on = a.id === agentId && mm.id === (model?.id ?? '')
                return (
                  <Row
                    key={a.id + mm.id}
                    onPress={() => {
                      setAgentId(a.id)
                      setModelId(mm.id)
                      setAgentSheet(false)
                    }}
                    style={on ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{mm.label}</T>
                      {mm.description ? (
                        <T numberOfLines={1} style={{ fontSize: 12.5, color: c.muted, marginTop: 3 }}>
                          {mm.description}
                        </T>
                      ) : null}
                    </View>
                    {on ? <T style={{ color: c.accent }}>✓</T> : null}
                  </Row>
                )
              })}
            </View>
          ))
        )}
      </Sheet>

      <Sheet
        open={permSheet}
        onClose={() => setPermSheet(false)}
        title="权限档"
        sub="决定代理自己能动多少东西。切换是全局的,影响之后所有操作。"
      >
        {PERMISSION_MODES.map((p) => {
          const on = p.id === perm
          return (
            <Row
              key={p.id}
              onPress={() => {
                setPerm(p.id)
                setPermSheet(false)
              }}
              style={on ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <T
                  style={{
                    fontSize: 14.5,
                    fontWeight: '600',
                    color: p.id === 'full' ? c.err : p.id === 'readonly' ? c.ok : c.fg,
                  }}
                >
                  {p.label}
                </T>
                <T style={{ fontSize: 12.5, lineHeight: 19, color: c.muted, marginTop: 3 }}>{p.desc}</T>
              </View>
              {on ? <T style={{ color: c.accent }}>✓</T> : null}
            </Row>
          )
        })}
      </Sheet>
    </View>
  )
}

const st = StyleSheet.create({
  you: {
    marginLeft: 34,
    marginTop: 14,
    paddingHorizontal: 13,
    paddingVertical: 10,
    borderRadius: 16,
    borderBottomRightRadius: 5,
    borderWidth: StyleSheet.hairlineWidth,
  },
  av: { width: 19, height: 19, borderRadius: 6, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  think: { marginLeft: 26, marginBottom: 6, paddingLeft: 10, borderLeftWidth: 2, fontSize: 12.5, lineHeight: 20 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth },
  entry: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 7 },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 12, paddingBottom: 10 },
})
