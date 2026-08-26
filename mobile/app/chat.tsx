import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import { goBack } from '../src/nav'
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, permissionModeLabel, type PermissionMode } from '../../src/shared/permissions'
import { useC } from '../src/theme/theme'
import { Banner, Btn, Chip, Empty, Field, IconBtn, LiveDot, Pill, Row, T, TimeSep, TopBar } from '../src/ui/kit'
import { GateCard } from '../src/ui/GateCard'
import { MessageBody } from '../src/ui/MessageBody'
import { ToolCards } from '../src/ui/ToolCard'
import { DelegateCards, SubagentCards } from '../src/ui/AgentCards'
import { sepsFor } from '../src/ui/timeSep'
import { providerSwitches } from '../src/ui/providerSwitch'
import { Sheet } from '../src/ui/Sheet'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useChat } from '../src/data/useChat'
import { useAgents } from '../src/data/useAgents'
import { useWorkflow } from '../src/data/useWorkflow'
import { WorkflowRibbon } from '../src/ui/WorkflowRibbon'
import { initialAutoScroll, nextScroll, type AutoScrollState } from '../src/ui/autoScroll'

/**
 * 对话屏,从会话列表(根屏)推入的下一层,总是带着一个已选会话进来。
 *
 * 版式照原型设计层 D:顶栏(返回 / 执行面板 / 停止)→ 状态条 → 消息流 → **钉住的门** → 输入区。
 * 门在输入区正上方且不参与滚动 —— 那是这一屏唯一的实底彩色块。
 */
/** 思考过程默认折叠。展开了它会把回答本身挤出屏幕 —— 手机上一屏就那么点地方。 */
function Think({ text }: { text: string }) {
  const c = useC()
  const [open, setOpen] = useState(false)
  const head = text.split('\n')[0] || '思考过程'
  return (
    <View style={{ paddingLeft: 26, marginBottom: 6 }}>
      <Pressable onPress={() => setOpen((v) => !v)} hitSlop={6}>
        <T style={{ fontSize: 12.5, color: c.faint }}>
          {open ? '▾ ' : '▸ '}
          {head}
        </T>
      </Pressable>
      {open ? <T style={[st.think, { color: c.muted, borderLeftColor: c.border2 }]}>{text}</T> : null}
    </View>
  )
}

export default function Chat() {
  const c = useC()
  const insets = useSafeAreaInsets()
  const { activeHost, state, online, reconnect } = useConn()
  const { selected, gates, gatesFor, answerGate, wsName, sessionTitle, setViewing, loading: storeLoading } = useStore()
  const { msgs, busy, send, stop, loading: chatLoading } = useChat(selected?.wsPath ?? null, selected?.sessionId ?? null)
  const { agents } = useAgents()
  const { wf, stage, advanceLabel, nextIsExecution, advance, exit, addFeedback } = useWorkflow()

  const [text, setText] = useState('')
  const [agentSheet, setAgentSheet] = useState(false)
  const [permSheet, setPermSheet] = useState(false)
  const [agentId, setAgentId] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [perm, setPerm] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [advanceSheet, setAdvanceSheet] = useState(false)
  const [suppSheet, setSuppSheet] = useState(false)
  const [supp, setSupp] = useState('')
  const [wfBusy, setWfBusy] = useState(false)
  const flow = useRef<ScrollView | null>(null)

  /**
   * ★**「你正在看这条会话」的唯一事实来源。**未读全靠它:store 的 `selected` 只是
   *  「进对话屏会打开哪一条」,冷启动就会自动选中一条(`store.tsx` 的默认选中 effect),
   *  而那一刻人在列表屏,一个字都没读 —— 拿 `selected` 当「在看」会让那条会话
   *  **永远**标不上未读(它在后台跑挂了,列表上也一点提示都没有)。
   *
   *  用 `useFocusEffect` 而不是「组件挂载/卸载」:对话屏是被 push 上去的一层,
   *  再往上推 `/exec`、`/gate` 时它**还挂在栈里没卸载**,但已经看不见了 ——
   *  那种时候本会话跑完就该算未读,回到这一屏(重新聚焦)时下面的 clear 再把它抹掉。
   *  `useFocusEffect` 的清理函数在**失焦和卸载**两种情况下都会跑(读过 expo-router 57
   *  的实现确认:blur 监听里调一次,useEffect 的 return 里也调一次),所以直接返回
   *  「写回 null」就够,不用另外补一个卸载分支。
   */
  useFocusEffect(
    useCallback(() => {
      setViewing(selected)
      return () => setViewing(null)
    }, [selected, setViewing]),
  )

  // 代理探测回来之前不知道选谁,回来之后落到第一个装了的。用户改过就不再动它。
  useEffect(() => {
    if (agentId || !agents.length) return
    setAgentId(agents[0].id)
    setModelId(agents[0].models[0]?.id ?? null)
  }, [agents, agentId])

  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId])
  const model = useMemo(() => agent?.models.find((m) => m.id === modelId) ?? agent?.models[0] ?? null, [agent, modelId])

  // 轮次分隔线:哪一条消息前面该来一根,由纯逻辑算(见 timeSep.ts)。
  // `now` 只在消息数变化时取一次 —— 每次渲染都取的话,「今天/昨天」会在午夜那一刻抖动,
  // 而且会让整份 Map 每帧都是新的。
  const seps = useMemo(() => sepsFor(msgs, Date.now()), [msgs])
  // 换代理提示:哪一条消息前面该来一条。规则见 providerSwitch.ts(和电脑端同一套)。
  const switches = useMemo(() => providerSwitches(msgs), [msgs])

  const myGates = selected ? gatesFor(selected.wsPath, selected.sessionId) : []
  // 本会话没门,但别处有,就把别处那道拿过来钉着 —— 门比「我正在看哪个会话」重要。
  const gate = myGates[0] ?? gates[0] ?? null
  const gateElsewhere = gate != null && myGates.length === 0
  // ★编号按**所有**挂着的门算,不是按本会话算。只按本会话算,两道门时会显示「门 1 / 1」,
  //  等于把另一台还在等的机器藏起来了。
  const gateIndex = gate ? gates.findIndex((g) => g.id === gate.id) : -1

  // ★落底:进屏那一次**瞬间到位**,之后的新消息才带动画。规则本身在 `autoScroll.ts`(有单测)。
  //  真机验收当场报的「进会话时历史哗哗刷一遍」就是这里原来无条件 `animated: true` 造成的。
  const autoScroll = useRef<AutoScrollState>(initialAutoScroll())
  useEffect(() => {
    const r = nextScroll(autoScroll.current, msgs.length)
    if (!r.scroll) return
    const animated = r.scroll.animated
    // 30ms 是等这一帧的布局落地 —— 立刻滚会滚到「还没算进新消息高度」的那个位置。
    const t = setTimeout(() => {
      // ★状态推进放在**真的滚了之后**,不是 effect 一进来就推进。清理函数会取消这个定时器
      //  (StrictMode 的双次调用,或者 30ms 内消息数又变了),那种情况下这一次滚动**根本没发生** ——
      //  状态要是已经推进过,「首帧瞬间到位」那一次就被悄悄吃掉了,现象要么又变回哗哗刷、要么干脆不落底。
      autoScroll.current = r.state
      flow.current?.scrollToEnd({ animated })
    }, 30)
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

  const runWf = async (fn: () => Promise<void>, okMsg: string) => {
    setWfBusy(true)
    try {
      await fn()
      setNotice(okMsg)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setWfBusy(false)
    }
  }

  const onAdvance = () => {
    // ★下一步是扇出阶段 = 每个项目各起一个代理,真花钱、真改代码。这一步必须先问一句,
    //  不能和「聊下一轮」用同一个无声的点击。对话阶段之间的推进没有这个成本,直接走。
    if (nextIsExecution) setAdvanceSheet(true)
    else void runWf(advance, '已推进')
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

  const tone = state?.status === 'ready' ? 'ok' : state?.status === 'connecting' ? 'wait' : 'off'

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}
        right={
          <IconBtn label="变更" onPress={selected ? () => router.push('/exec') : undefined} disabled={!selected || !online}>
            📄
          </IconBtn>
        }
      >
        <View style={{ paddingHorizontal: 2, paddingVertical: 2 }}>
          <T numberOfLines={1} style={{ fontSize: 15.5, fontWeight: '600', letterSpacing: -0.3, color: c.fg }}>
            {/* 没选中时用 `未选会话` —— 和 exec/workflow 两屏的同一处措辞对齐,
                也别再喊「选一个会话」:这个标题不可点,这一屏没有挑会话的入口。 */}
            {selected ? sessionTitle(selected.wsPath, selected.sessionId) : '未选会话'}
          </T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 }}>
            <LiveDot tone={tone} />
            <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, flexShrink: 1 }}>
              {activeHost?.label ?? '未选主机'}
              {selected ? ` · ${wsName(selected.wsPath)}` : ''}
            </T>
          </View>
        </View>
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

      {wf ? (
        <WorkflowRibbon
          flowName={wf.flowName}
          stageIndex={wf.currentIndex}
          stageCount={wf.stages.length}
          stageName={stage?.name ?? ''}
          provider={stage?.provider ?? ''}
          phase={wf.phase}
          advanceLabel={advanceLabel}
          advanceDisabled={!online || busy || wfBusy}
          onAdvance={onAdvance}
          onExit={() => void runWf(exit, '已退出工作流')}
          onSupplement={() => setSuppSheet(true)}
        />
      ) : null}

      <ScrollView ref={flow} style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 10 }}>
        {msgs.length === 0 && (storeLoading || chatLoading) ? (
          <Empty title="正在读取…" />
        ) : !selected ? (
          // 换主机会把选中清空(store.tsx),而这一屏还在栈里 —— 于是就落到这儿。
          // 这一屏自己没有「挑一条」的入口,所以只能指回上一层,别再许诺点不到的东西。
          <Empty title="没有正在看的会话" desc={'刚换过主机的话,原来选中的那条已经不在了。\n点左上角 ‹ 回会话列表,挑一条进来。'} />
        ) : msgs.length === 0 ? (
          online ? (
            <Empty title="这个会话还没有消息" desc="在下面给代理下达任务。" />
          ) : (
            // 断线且这个会话一条都没拉到过。这里必须说清是「没连上」而不是「真的没消息」。
            <Empty title="未连接" desc={'还没读到这个会话的内容。\n第一版不做离线缓存,连上就有了。'} />
          )
        ) : (
          <>
            {msgs.map((m) => (
              <React.Fragment key={m.id}>
                {seps.has(m.id) ? <TimeSep>{seps.get(m.id)}</TimeSep> : null}
                {switches.has(m.id) ? (
                  <TimeSep>
                    {`切换编码代理 ${switches.get(m.id)!.from} → ${switches.get(m.id)!.to} · 新代理基于历史重建上下文,可能有损`}
                  </TimeSep>
                ) : null}
                {m.who === 'user' ? (
                  <View style={[st.you, { backgroundColor: c.accentDim, borderColor: c.youBorder }]}>
                    <T style={{ fontSize: 15, lineHeight: 23, color: c.fg }}>{m.text}</T>
                  </View>
                ) : (
                  <View style={{ marginTop: 14 }}>
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
                    {m.think ? <Think text={m.think} /> : null}
                    {/* 思考 → 工具 → 子代理 → 正文。和桌面端 Message.tsx 的次序一致,别两边各排各的。 */}
                    <ToolCards tools={m.tools} />
                    <SubagentCards cards={m.subagents} />
                    <MessageBody text={m.text} streaming={m.streaming} />
                    {/* 委派批次挂在正文**下面**:主轮次已经答完了,它们还在后台跑。 */}
                    <DelegateCards batches={m.delegates} />
                    {m.error ? (
                      <T style={{ fontSize: 12.5, color: c.err, paddingLeft: 26, marginTop: 6 }}>{m.error}</T>
                    ) : null}
                  </View>
                )}
              </React.Fragment>
            ))}
            {/* 门挂着时在流的末尾留一行。不留的话,消息流看上去就是「代理说到一半不说了」。 */}
            {myGates.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 14, paddingLeft: 26 }}>
                <Pill tone="gate">已暂停</Pill>
                <T style={{ fontSize: 12.5, color: c.muted }}>代理停在门上,回答后从这里继续</T>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>

      {/* ── 门:钉在输入区正上方,不参与滚动 ───────────────────────────────── */}
      {gate ? (
        <View style={{ paddingHorizontal: 10, paddingBottom: 6, backgroundColor: c.bg }}>
          {gateElsewhere ? (
            <Pressable
              // ★`goBack()` 而不是 `router.push('/')`:push 永远是**追加**,会在
              //  `[/, /chat]` 上再压一个全新的根屏,栈变成 `[/, /chat, /]` ——
              //  列表屏没有 ‹,Android 的物理返回于是退回对话屏而不是退出,来回一趟栈就长一截。
              onPress={() => goBack()}
              style={{ paddingBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <T style={{ fontSize: 11.5, color: c.gate }}>
                这道门来自另一个会话:{wsName(gate.wsPath)} · {sessionTitle(gate.wsPath, gate.sessionId)}
              </T>
            </Pressable>
          ) : null}
          <GateCard
            gate={gate}
            index={gateIndex < 0 ? 0 : gateIndex}
            total={gates.length}
            online={online}
            where={`${wsName(gate.wsPath)} · ${sessionTitle(gate.wsPath, gate.sessionId)}`}
            perm={permissionModeLabel(perm)}
            onAllow={() => void answer('allow')}
            onDeny={() => void answer('deny')}
            onOpen={() => router.push({ pathname: '/gate', params: { id: gate.id } })}
            // ★「按允许之前你想看的就是它改了什么」—— 变更页带着门 id 推进去,那一屏会把这道门
            //  原样钉在底下,看完就地答,不用再退回这里找。选择题门不摆:那种门问的是「选哪个方案」,
            //  diff 帮不上忙。
            onPeek={
              gate.kind === 'confirm'
                ? () => router.push({ pathname: '/exec', params: { gate: gate.id } })
                : undefined
            }
            // ★`goBack()` 而不是 `router.push('/')`,理由同上面那条注释:push 永远是追加。
            onList={() => goBack()}
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
          {/* ★chip 行放输入框上方,跟着键盘一起顶上去 —— 正要在什么权限档下发消息,
              不该是那种随手一滑就滚出视野的东西。 */}
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
            {/* 已经在工作流里就不再给启动入口 —— 一个会话同时只能在一条流上。 */}
            {!wf ? (
              <Chip onPress={online && selected ? () => router.push('/workflow') : undefined} disabled={!online || !selected}>
                / 工作流
              </Chip>
            ) : null}
          </View>
          <View style={st.entry}>
            <Field
              value={text}
              onChangeText={setText}
              placeholder={online ? '给代理下达任务…' : '未连接 · 发不出去'}
              multiline
              editable={online && !!selected}
              style={{ flex: 1, minHeight: 44, maxHeight: 108 }}
            />
            {/* ★忙的时候,这颗键**就地**变成停止 —— 位置、尺寸都不动。
                停止是这一屏最紧急的动作,而它原来待在顶栏右上角,是单手最够不到的地方。 */}
            <Pressable
              onPress={busy ? () => void stop() : doSend}
              disabled={busy ? !online : !online || !selected || !text.trim() || sending}
              style={({ pressed }) => [
                st.send,
                busy
                  ? { backgroundColor: c.err, borderColor: c.err }
                  : { backgroundColor: c.accent, borderColor: c.accent },
                pressed && { opacity: 0.85 },
                (busy ? !online : !online || !selected || !text.trim() || sending) && { opacity: 0.4 },
              ]}
            >
              <T style={{ fontSize: busy ? 15 : 17, color: busy ? c.bg : c.onAccent }}>
                {busy ? '■' : '↑'}
              </T>
            </Pressable>
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
        open={advanceSheet}
        onClose={() => setAdvanceSheet(false)}
        title="下一步会开始执行"
        sub="接下来这一步是扇出阶段:每个选中的项目各起一个代理,在临时分支上真的改代码。"
      >
        <Btn
          kind="pri"
          block
          disabled={wfBusy}
          onPress={() => {
            setAdvanceSheet(false)
            void runWf(advance, '已开始执行')
          }}
        >
          {advanceLabel || '开始执行'}
        </Btn>
        <Btn kind="ghost" block onPress={() => setAdvanceSheet(false)}>
          再想想
        </Btn>
      </Sheet>

      <Sheet
        open={suppSheet}
        onClose={() => setSuppSheet(false)}
        title="补充说明"
        sub="追加一段话给正在跑的这条流。它会进下一个阶段的提示词,由代理自己消化 —— 不改工作流本身的配置。"
      >
        <Field
          value={supp}
          onChangeText={setSupp}
          placeholder="比如:别动 migrations/,先跑一遍测试再说。"
          multiline
          style={{ minHeight: 80 }}
        />
        <Btn
          kind="pri"
          block
          disabled={!supp.trim() || wfBusy}
          onPress={() => {
            const t = supp.trim()
            setSuppSheet(false)
            setSupp('')
            void runWf(() => addFeedback(t), '已记下,下一个阶段会带上')
          }}
        >
          提交
        </Btn>
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
  think: { marginTop: 6, paddingLeft: 10, borderLeftWidth: 2, fontSize: 12.5, lineHeight: 20 },
  foot: { borderTopWidth: StyleSheet.hairlineWidth },
  // ★chip 行现在排在输入框上面(见 Step 4),所以「贴容器顶边的间距」和「两行之间的间距」
  // 从 entry 挪到了 chips 头上;entry 掉到最后,接手原来 chips 尾部那段「离安全区还有多远」的间距。
  entry: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingBottom: 10 },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 7 },
})
