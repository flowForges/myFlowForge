import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useFocusEffect } from 'expo-router'
import { goBack } from '../src/nav'
import { CH } from '../../src/main/ipc/channels'
import type { Attachment } from '../../src/shared/types'
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, permissionModeLabel, type PermissionMode } from '../../src/shared/permissions'
import {
  base64OfUtf8,
  insertPastePlaceholder,
  pastedFileName,
  pastePlaceholder,
  shouldOffloadPaste,
} from '../../src/shared/chat/largePaste'
import { textAfterOffload } from '../src/ui/pasteOffload'
import { continueList } from '../src/ui/listContinue'
import { planPickedImage } from '../src/ui/pickedImage'
import { CAN_COPY, CopyBtn } from '../src/ui/CopyBtn'
import { Icon } from '../src/ui/Icon'
import { canPickImage } from '../src/net/pickSupport'
import { RADIUS } from '../src/theme/tokens'
import { useC } from '../src/theme/theme'
import { Banner, Btn, Chip, Empty, Field, IconBtn, LiveDot, Pill, ProviderSwitchSep, Row, T, TimeSep, TopBar } from '../src/ui/kit'
import { GateCard } from '../src/ui/GateCard'
import { MessageBody } from '../src/ui/MessageBody'
import { ToolCards } from '../src/ui/ToolCard'
import { DelegateCards, SubagentCards } from '../src/ui/AgentCards'
import { sepsFor } from '../src/ui/timeSep'
import { providerSwitches } from '../src/ui/providerSwitch'
import { Sheet } from '../src/ui/Sheet'
import { BigEditor } from '../src/ui/BigEditor'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { canPeekGate } from '../src/data/gatePeek'
import { useChat } from '../src/data/useChat'
import { useAgents } from '../src/data/useAgents'
import { useCommands } from '../src/data/useCommands'
import { isSlashQuery, slashRows } from '../src/ui/slashPick'
import { useWorkflow } from '../src/data/useWorkflow'
import { WorkflowRibbon } from '../src/ui/WorkflowRibbon'
import { atBottom, initialAutoScroll, nextScroll, type AutoScrollState } from '../src/ui/autoScroll'
import { pickSessionAgent } from '../src/ui/sessionAgent'

/**
 * 对话屏,从会话列表(根屏)推入的下一层,总是带着一个已选会话进来。
 *
 * 版式照原型设计层 D:顶栏(返回 / 执行面板 / 停止)→ 状态条 → 消息流 → **钉住的门** → 输入区。
 * 门在输入区正上方且不参与滚动 —— 那是这一屏唯一的实底彩色块。
 */
/**
 * ★这个探测在**模块作用域只跑一次**,一辈子不会变(装在这台手机上的那个包里有没有这个原生模块,
 *  是编译期就定死的事)。为假时下面**根本不渲染那个入口** —— 不是灰的、不是点了弹一句,是没有。
 *  理由见 `src/net/pickSupport.ts` 顶部:上一次「按钮照常显示、点下去当场崩」。
 *  (剪贴板那一个是同样的道理,现在和按钮本体一起住在 `src/ui/CopyBtn.tsx`。)
 */
const CAN_PICK = canPickImage()

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
  const { activeHost, state, online, reconnect, invoke } = useConn()
  const { groups, selected, gates, gatesFor, answerGate, wsName, sessionTitle, setViewing, loading: storeLoading } = useStore()
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
  const [bigEditor, setBigEditor] = useState(false)
  /**
   * 选中一条斜杠命令之后把面板收起来。
   * ★多数模板末尾自带一个空格(`/analyst `),下一拍 `isSlashQuery` 自己就变假了 ——
   *  但技能那种模板是一段中文,而万一哪条模板正好是个光秃秃的 `/foo`,没有这个闸门面板会当场
   *  又弹回来。电脑端 `Composer.tsx` 的 `slashDismissed` 就是为这个存在的,规则照抄:
   *  **正文一旦不再是斜杠查询就自动解除**(见 `onType`),这样重新打一个 `/` 还能再开。
   */
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [wfBusy, setWfBusy] = useState(false)
  /** 已经转成附件的那几坨。发出去之后清空 —— 附件是跟着这一条消息走的,不是这个会话的常驻物。 */
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [offloadBusy, setOffloadBusy] = useState(false)
  const [pickBusy, setPickBusy] = useState(false)
  const flow = useRef<ScrollView | null>(null)
  /**
   * 输入框**这次改动之前**的光标位置,以及「要不要把光标摆回某处」。
   *
   * ★两样都只为「回车续列表」服务(见 `src/ui/listContinue.ts`):
   *  - `caretRef`:RN 上 `onSelectionChange` 报的是改动前那一拍的位置,而分辨「换行插在连续换行的
   *    哪一个位置」只能靠它 —— 光看正文是分不出来的。用 ref 不用 state:每敲一个字都要更新,
   *    进 state 就是每个键一次多余的重渲染。
   *  - `sel`:**一次性**的受控光标。补上 `2. ` 之后光标必须落在标记后面,否则会掉到正文末尾
   *    (在一段话中间续列表时,接着打的字就跑到最后一行去了)。用完立刻清回 `undefined`
   *    交还给原生 —— 一直受控的话,每个键都会把光标拽回同一个位置。
   *    ★清理有**两条**路(选区变了、或者又改了字),一条都不能少:少了它就可能一直卡在受控态。
   */
  const caretRef = useRef(0)
  const [sel, setSel] = useState<{ start: number; end: number } | undefined>(undefined)

  /**
   * 输入框里每一次正文变化。绝大多数时候就是原样写回去;只有当这一下**恰好是插入了一个换行**、
   * 而且光标那一行是个列表项时,才改写成「续上下一个标记」或者「结束列表」。
   * 判据全在 `listContinue.ts`(有单测 + 变异验证),这里只负责把结果落到 state 上。
   *
   * ★不碰发送:回车永远只是换行,发送只有右边那颗键一条路。手机上没有「Shift+回车」可用,
   *  让回车发送就等于**没法打多行** —— 而给代理下达任务本来就是多行的事。
   */
  const onType = (next: string) => {
    // 正文已经不是「在挑命令」了(打了空格、或者把斜杠删了)就把闸门放掉,
    // 这样重新打一个 `/` 面板还能再开。和电脑端 `Composer.tsx` 的 onChange 一处一样。
    if (!isSlashQuery(next)) setSlashDismissed(false)
    const edit = continueList(text, next, caretRef.current)
    if (!edit) {
      setText(next)
      setSel(undefined)
      return
    }
    setText(edit.text)
    caretRef.current = edit.caret
    setSel({ start: edit.caret, end: edit.caret })
  }

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

  /**
   * 代理和模型**跟着会话走**。
   *
   * ★原来这里是「探测回来之后落到第一个装了的,用户改过就不再动它」—— 一份纯本地 state,
   *  切会话不复位、也不写回服务端。而 `ChatSession` 上早就有 `agentId` / `modelId` 两个字段,
   *  服务端每条会话各存一份。挪到顶栏常驻显示之后,这个偏差会被一眼看见。
   * ★判据全在 `sessionAgent.ts`(有单测 + 变异验证):代理被卸载 / 模型改名 时各退各的。
   * ★依赖里带上 `selected` 的两段 —— 换了会话就要重新挑。
   */
  const currentSession = useMemo(
    () =>
      selected
        ? (groups.find((g) => g.ws.path === selected.wsPath)?.sessions.find((s) => s.id === selected.sessionId) ?? null)
        : null,
    [groups, selected],
  )
  useEffect(() => {
    const p = pickSessionAgent(currentSession, agents)
    setAgentId(p.agentId)
    setModelId(p.modelId)
  }, [currentSession, agents])

  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? null, [agents, agentId])
  const model = useMemo(() => agent?.models.find((m) => m.id === modelId) ?? agent?.models[0] ?? null, [agent, modelId])

  /**
   * 斜杠命令。用户原话「输入框,输入 / 好像加载不到支持的命令」—— 手机端在这之前一条都没接。
   * ★清单**按代理 + 按工作区**现问(见 `useCommands.ts`),哪几条该显示由 `slashPick.ts`
   *  这个零 import 的纯模块决定(有单测 + 变异验证),这里只管画。
   */
  const { commands, supported: cmdsSupported } = useCommands(agentId, selected?.wsPath ?? null)
  const slash = slashRows(commands, text, { supported: cmdsSupported, dismissed: slashDismissed })

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

  /**
   * ★落底:进屏那一次**瞬间到位**,之后跟着新内容走;**人一往上翻就立刻停手**。
   *  规则本身在 `autoScroll.ts`(有单测 + 变异验证),这里只负责喂它三个数、并把结果落地。
   *
   * ★★判据是「条数 + **最后一条正文的长度**」,不是只看条数:一轮回答从头到尾就是**一条**消息,
   *  流式吐字只把它越接越长。只看条数的那一版,整轮输出期间一次都不会滚 —— 就是用户报的
   *  「LLM 在一直输出,页面应该一直滚动」。
   *
   * ★★`atBottomRef` **只写 ref、不进 state**:`onScroll` 每秒来十几次,进 state 就是每秒十几次
   *  重渲染整条消息流(和 `app/index.tsx` 的定位气泡同一条规矩)。它只被下面这个 effect 读,
   *  而 effect 是由消息内容变化触发的 —— 不需要靠它自己触发渲染。
   */
  const autoScroll = useRef<AutoScrollState>(initialAutoScroll())
  const atBottomRef = useRef(true)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 定时器到期时要滚成什么样 / 状态该推进到哪。只有真的滚了才作数(见下)。 */
  const pending = useRef<{ animated: boolean; state: AutoScrollState } | null>(null)
  // 末条正文长度。放进依赖数组,流式吐字才有东西触发这个 effect。
  const tailLen = msgs.length ? msgs[msgs.length - 1].text.length : 0
  useEffect(() => {
    const r = nextScroll(autoScroll.current, { count: msgs.length, tail: tailLen, atBottom: atBottomRef.current })
    if (!r.scroll) {
      // 不该滚:状态就地推进,并且**撤掉已经排上的那一次** —— 人这一刻可能刚好翻上去了,
      // 让上一拍排的滚动照常执行,就是「他划走的同时被拽回底部」。
      if (scrollTimer.current) {
        clearTimeout(scrollTimer.current)
        scrollTimer.current = null
        pending.current = null
      }
      autoScroll.current = r.state
      return
    }
    pending.current = { animated: r.scroll.animated, state: r.state }
    // ★★**已经排了一次就让它照原计划打,不要重排。**30ms 是等这一帧的布局落地(立刻滚会滚到
    //  「还没算进新内容高度」的那个位置)。但流式吐字时 30ms 内经常来好几片:每来一片就
    //  clearTimeout 再重排的话,这个定时器**永远等不到到期**,画面反而一动不动 —— 正是要治的病。
    //  不重排 ⇒ 最多 30ms 内必滚一次,滚的是**那一刻**的最新内容(`pending` 一直被覆盖成最新)。
    if (scrollTimer.current) return
    scrollTimer.current = setTimeout(() => {
      scrollTimer.current = null
      const p = pending.current
      pending.current = null
      if (!p) return
      // ★状态推进放在**真的滚了之后**,不是 effect 一进来就推进:上面那条「撤掉」的路径会让
      //  这一次滚动根本不发生,状态要是已经推进过,「首帧瞬间到位」那一次就被悄悄吃掉了
      //  (现象要么又变回哗哗刷、要么干脆不落底)。
      autoScroll.current = p.state
      flow.current?.scrollToEnd({ animated: p.animated })
    }, 30)
  }, [msgs.length, tailLen])
  // 卸载时收尾。★**只在卸载时清**:每次依赖变化都清的话就是上面说的「永远等不到到期」。
  useEffect(() => () => { if (scrollTimer.current) clearTimeout(scrollTimer.current) }, [])

  /**
   * 把一段字节存成这个工作区的附件,并挂进 chip 行。**「转成附件」和「从相册发图」共用这一段。**
   *
   * ★为什么必须共用而不是各写一份:两条路本来是逐字重复的同一段(同一个 channel、同一个
   *  `as Attachment | null`、同一句失败文案)。重复的错误文案迟早会飘 —— 改一边忘一边,
   *  于是同一件事在两个入口说两句不一样的话。更要命的是 `att === null` 这一条:服务端写不进去时
   *  返回的是 **null(它不抛)**,只要有一边忘了处理,那边就是静默存进一个 undefined 附件 ——
   *  chip 上一片空白,发出去 agent 什么都读不到,而人以为存好了。
   */
  const saveAttachment = async (name: string, dataBase64: string): Promise<Attachment> => {
    if (!selected) throw new Error('没有正在看的会话')
    const att = (await invoke(CH.chatSavePaste, [
      { workspacePath: selected.wsPath, name, dataBase64 },
    ])) as Attachment | null
    if (!att) throw new Error('存不进工作区的附件目录(盘满 / 没权限?)')
    setAttachments((a) => [...a, att])
    return att
  }

  /**
   * 把输入框里这一大坨转成工作区里的附件,正文里留一个 `[文件名]` 占位符。
   *
   * ★为什么是「点一下」而不是像电脑端那样粘进来就自动转:**RN 的 `TextInput` 根本没有 `onPaste`**
   *  (SDK 57 零命中),手机上拦不到粘贴这件事。而且**绝不能**拿「字数突然暴涨」去猜是粘贴 ——
   *  语音听写也是一次塞进一大段:你说了段话,它给你转成文件,比什么都不做更糟。
   *  所以宁可多要人一下点击,也不去猜他刚才干了什么。
   */
  const offload = async () => {
    if (!selected) return
    const raw = text
    const name = pastedFileName(raw, new Date())
    setOffloadBusy(true)
    try {
      const att = await saveAttachment(name, base64OfUtf8(raw))
      // ★存盘是异步的,这几百毫秒里人还能接着打字。所以**必须**走函数式更新:`latest` 是写回
      //  那一刻输入框里真实的正文,而 `text` 是 await 之前那份快照。拿快照去比,等于拿 raw
      //  和它自己比 —— 判据恒真,「退到末尾」那条兜底分支永远进不去,而且这一下 setText 会
      //  把等待期间打的字整段盖掉(粘 3000 字 → 点转 → 打「先看这个」→ 那四个字凭空消失)。
      //  判据本身在 `pasteOffload.ts`,那里有单测钉着。
      setText((latest) => textAfterOffload(latest, raw, att.name))
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setOffloadBusy(false)
    }
  }

  /**
   * 从相册挑一张图,存进这个工作区的附件目录,正文末尾留一个占位符。
   *
   * ★**零新 channel**:`chat:save-paste` 本来就在手机拿得到的方法表里,图片和「粘的一大坨文本」
   *  在服务端那头是同一件事(一段字节 + 一个文件名 → 写进 `.forge/attachments/`)。
   * ★占位符落在**正文末尾**,不像 offload 那样替换选区:图不是从输入框里来的,没有「它原来占哪一段」
   *  这回事。但占位符本身一样不能省 —— 连发三张图而正文里没有任何位置标记,agent 就分不清
   *  哪句话在说哪张图(理由见 largePaste.ts)。
   */
  const pickImage = async () => {
    if (!selected) return
    setPickBusy(true)
    try {
      // ★**运行时 require,绝不能静态 import**:metro 会把静态 import 提到最前面无条件执行,
      //  那样上面 `CAN_PICK` 那句探测就白做了 —— 旧包照样崩在 import 那一行(同 `app/scan.tsx`)。
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ip = require('expo-image-picker') as typeof import('expo-image-picker')
      // ★`quality: 0.8` 且**不改尺寸**是有意的:代理要看的是截图上的字,压糊了等于白传。
      //  代价是原图多大发多大,所以下面 planPickedImage 那条大小闸门是必需的,不是保险。
      const r = await ip.launchImageLibraryAsync({ mediaTypes: ['images'], base64: true, quality: 0.8 })
      if (r.canceled) return
      const plan = planPickedImage(r.assets[0] ?? {}, new Date())
      if (!plan.ok) throw new Error(plan.why)
      const att = await saveAttachment(plan.name, plan.dataBase64)
      // ★函数式更新:选图 + 存盘是好几秒的事,这中间人完全可能已经在打字了。拿 await 之前的
      //  `text` 快照写回去,就是把他这几秒里打的字整段吃掉(offload 那边刚踩过这个坑)。
      setText((latest) => insertPastePlaceholder(latest, latest.length, latest.length, att.name).text)
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    } finally {
      setPickBusy(false)
    }
  }

  /**
   * 删掉一个附件 chip。
   * ★**不去动正文里的占位符**:那行字是人自己写的,我们没资格替他改。只说一声发生了什么,
   *  要删让他自己删 —— 静默地从他的话里抠掉一段,比留着一个多余的方括号糟糕得多。
   */
  const dropAttachment = (a: Attachment) => {
    setAttachments((list) => list.filter((x) => x.path !== a.path))
    setNotice(`已移除附件 ${a.name} · 正文里的 ${pastePlaceholder(a.name)} 还留着,要的话自己删`)
  }

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
        attachments,
      })
      setText('')
      setAttachments([])
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
            <Icon name="changes" size={19} color={c.muted} />
          </IconBtn>
        }
      >
        {/* ★★第一行是**会话标题**,第二行是**代理 · 模型**,整行可点开下拉。
            原来第二行是「主机名 · 工作区名」—— 主机已经由首页顶栏那条横幅常驻回答了,
            进了对话屏再报一遍是重复;而「这条消息要发给谁」才是这一屏每一次发送前都要确认的事。
            ★那颗连接状态圆点留着:断线态必须显式,这条不许动。 */}
        <View style={{ paddingHorizontal: 2 }}>
          <T numberOfLines={1} style={{ fontSize: 15.5, fontWeight: '600', letterSpacing: -0.3, color: c.fg }}>
            {/* 没选中时用 `未选会话` —— 和 exec/workflow 两屏的同一处措辞对齐,
                也别再喊「选一个会话」:这个标题不可点,这一屏没有挑会话的入口。 */}
            {selected ? sessionTitle(selected.wsPath, selected.sessionId) : '未选会话'}
          </T>
          <Pressable
            onPress={online ? () => setAgentSheet(true) : undefined}
            disabled={!online}
            // ★整行热区,而且用 padding 撑不用 hitSlop —— hitSlop 在祖先紧贴子节点时是死的。
            style={({ pressed }) => [
              { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1, paddingVertical: 3 },
              pressed && { opacity: 0.6 },
            ]}
          >
            <LiveDot tone={tone} />
            <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, flexShrink: 1, minWidth: 0 }}>
              {agent ? `${agent.displayName}${model ? ' · ' + model.label : ''}` : '选代理'}
            </T>
            {/* ▾ 是「这儿能点开」的唯一信号 —— 手机上没有 hover。 */}
            <Icon name="chevronDown" size={9} color={c.faint} />
          </Pressable>
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

      <ScrollView
        ref={flow}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 14, paddingBottom: 10 }}
        // ★64ms 和 `app/index.tsx` 的定位气泡取同一个值:这只是「人现在在不在底下」这一个布尔量,
        //  不需要每一帧都问。回调里只写 ref,而且**值没变就一个字都不写** —— 和那边一样的规矩。
        scrollEventThrottle={64}
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent
          const next = atBottom({
            contentH: contentSize.height,
            offsetY: contentOffset.y,
            viewH: layoutMeasurement.height,
          })
          if (next !== atBottomRef.current) atBottomRef.current = next
        }}
      >
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
                {/* ★换代理提示照电脑端的形状走(见 kit.tsx 的 `ProviderSwitchSep`):
                    原来它挤在 `TimeSep` 里,和「昨天 14:02」一个字号一个灰度,人根本不会注意到 ——
                    而这条恰恰是「后面的回答为什么忽然变了口径」的唯一解释。
                    ★**哪一条前面该有**由 `providerSwitch.ts` 决定(和电脑端同一套规则),这里只管画。 */}
                {switches.has(m.id) ? (
                  <ProviderSwitchSep from={switches.get(m.id)!.from} to={switches.get(m.id)!.to} />
                ) : null}
                {m.who === 'user' ? (
                  <View>
                    <View style={[st.you, { backgroundColor: c.accentDim, borderColor: c.youBorder }]}>
                      <T style={{ fontSize: 15, lineHeight: 23, color: c.fg }}>{m.text}</T>
                    </View>
                    {/* ★自己说过的话也要能复制,而且**只能**是个看得见的入口:
                        长按整条是苹果自己的选字手势,抢过来等于把「只复制其中一段」也一起没收了 ——
                        而人要拿回去的多半正是里头那一行路径、一条命令。
                        ★摆在气泡**下面**、右对齐:气泡是右侧来的,复制跟着它那一侧;
                        放进气泡里会挤掉正文宽度(这一屏本来就只有 390)。
                        ★`CAN_COPY` 为假(旧包里没有 expo-clipboard)时整颗不摆 —— 同代理那一侧的规矩。
                        ★原来这里还外挂了 `paddingRight: 3` / `marginTop: 3`,现在去掉了:按钮自己带了
                        11/10 的内边距(见 `CopyBtn.tsx` —— 可点区域只能这么长出来),再叠一层就是双份间距。 */}
                    {CAN_COPY && m.text.trim() ? (
                      <View style={{ alignItems: 'flex-end' }}>
                        <CopyBtn text={m.text} />
                      </View>
                    ) : null}
                  </View>
                ) : (
                  <View style={{ marginTop: 14 }}>
                    {/* ★`marginBottom` 从 6 收到 1:这一行现在由复制按钮的 padding 撑到 33pt 高
                        (原来 19pt,理由见 `CopyBtn.tsx`),多出来的高度已经够当间距了。 */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 1 }}>
                      <View style={[st.av, { backgroundColor: c.surface2, borderColor: c.border2 }]}>
                        <T style={{ fontSize: 10, fontWeight: '700', color: c.fg2 }}>
                          {(m.model ?? 'A').slice(0, 1).toUpperCase()}
                        </T>
                      </View>
                      <T mono numberOfLines={1} style={{ fontSize: 11, letterSpacing: 0.4, color: c.faint, flexShrink: 1 }}>
                        {m.model ?? '代理'}
                      </T>
                      {/* 复制排在这一行的最右边:头一行本来就是「这条是谁说的」,复制的是这条,位置对得上。
                          ★正文空的时候不摆 —— 那种消息只有工具卡,复制过去是一个空字符串。 */}
                      {CAN_COPY && m.text.trim() ? (
                        <View style={{ marginLeft: 'auto' }}>
                          <CopyBtn text={m.text} />
                        </View>
                      ) : null}
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
            //  原样钉在底下,看完就地答,不用再退回这里找。
            //  ★★**摆不摆这颗按钮的判断在 `canPeekGate` 里,连同它为什么不许被放宽的理由**
            //  (一句话:借来的门 + 本会话的 diff = 拿 W1 的 diff 给 W2 的门当依据)。
            //  下一个人看着「借来的门上少了个按钮」想加回来之前,先去读那段注释。
            onPeek={
              canPeekGate(gate, selected?.wsPath)
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
          {/* ── 斜杠命令面板 ──────────────────────────────────────────────────
              ★摆在输入区**最上面**,跟着键盘一起顶上去:人正在打的那个 `/` 就在下面一行,
                面板离得越近越不用把视线甩来甩去。
              ★**一条都没有就整个不摆**(`slash.length`),包括「这台主机根本没有 commands:list」
                那种情况(判据在 `slashPick.ts` 的 `slashRows`)—— 空面板等于告诉人「你一条命令
                都没有」,而真相可能是这台主机的版本里压根没有这个方法。
              ★★`keyboardShouldPersistTaps="handled"`:这个面板**只在键盘弹着的时候存在**。
                不给这个值,ScrollView 会把第一下点击吃掉去收键盘 —— 现象是「点了没反应,要点两下」,
                而点第二下时键盘已经收了、面板也跟着没了(chip 那一行踩过同一个坑)。
              ★`maxHeight`:命令多的机器上一口气几十条,不封顶就把整个对话流顶出屏幕。 */}
          {slash.length ? (
            <View style={[st.slash, { backgroundColor: c.bg2, borderColor: c.border2 }]}>
              <T style={{ fontSize: 10.5, letterSpacing: 0.6, color: c.faint, paddingHorizontal: 11, paddingTop: 8 }}>
                命令 · {agent?.displayName ?? agentId ?? ''}
              </T>
              <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 168 }}>
                {slash.map((cmd) => (
                  <Pressable
                    key={cmd.cmd}
                    onPress={() => {
                      // 电脑端 `chooseSlash` 就是这么做的:模板**替换**整段正文,不是插在光标处。
                      // 斜杠命令只在开头成立,所以此刻正文里除了这段 `/xxx` 本来也没别的东西。
                      setText(cmd.template)
                      setSel(undefined)
                      setSlashDismissed(true)
                    }}
                    style={({ pressed }) => [st.slashRow, pressed && { backgroundColor: c.surface2 }]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                      <T mono style={{ fontSize: 12.5, color: c.accent }}>
                        {cmd.cmd}
                      </T>
                      {/* 「技能」和「本机自定义命令」是两种东西:前者是代理自己会挑着用的,
                          后者是用户写在磁盘上的一段提示词。标出来,别混成一堆。 */}
                      <T style={{ fontSize: 10, color: c.faint }}>{cmd.kind === 'skill' ? '技能' : '本机'}</T>
                    </View>
                    {cmd.desc ? (
                      <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, marginTop: 2 }}>
                        {cmd.desc}
                      </T>
                    ) : null}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}

          {/* ★「这段有 N 字 · 转成附件?」——**显式一按**,理由见 offload() 上面那段注释:
              手机上拦不到粘贴,而拿字数暴涨去猜会把语音听写的一段话变成一个文件。
              低对比度一条,排在 chip 行**上面**:它是对输入框内容的评论,不是一个操作档位。 */}
          {shouldOffloadPaste(text) && online && !!selected ? (
            <Pressable
              onPress={offloadBusy ? undefined : () => void offload()}
              disabled={offloadBusy}
              style={({ pressed }) => [
                st.offload,
                { backgroundColor: c.bg2, borderColor: c.border2 },
                pressed && { backgroundColor: c.surface2 },
                offloadBusy && { opacity: 0.5 },
              ]}
            >
              <T style={{ fontSize: 12, lineHeight: 18, color: c.muted }}>
                {offloadBusy
                  ? '正在存进工作区…'
                  : `这段有 ${text.length} 字 · 转成附件?正文里会留一个占位符,代理照样读得到。`}
              </T>
            </Pressable>
          ) : null}

          {/* ★chip 行放输入框上方,跟着键盘一起顶上去 —— 正要在什么权限档下发消息,
              不该是那种随手一滑就滚出视野的东西。
              ★★**横向滚动,不换行**:真机上 390pt 只放得下「自动 (工作区)」「🖼 图片」两颗,
                `/ 工作流` 已经被挤到第二行,再挂两个附件 chip 就是三行 —— 输入区跟着长高,键盘一顶,
                正文只剩两行可见。换成一条横向滚动的轨道后**行高恒定**:多出来的往右滑就是。
              ★★2026-08-28:「代理 · 模型」那一颗已经上顶栏了(它不会一直切换,不该占着输入区的位置),
                权限那一颗挪到了输入框左侧(见 Task 7)。这条轨道现在只剩**附件 chip**。
              ★`flexGrow: 0` 是必需的:`ScrollView` 自带 flexGrow,在这个竖排容器里会去抢剩余高度。
                高度改由 `contentContainerStyle`(chip 自己的 minHeight 32 + 上下 padding)撑出来 ——
                所以那份样式里**不能**只剩 flexDirection,否则整条轨道塌成 0 高、chip 全部看不见。
              ★`keyboardShouldPersistTaps="handled"`:这一行的全部意义就是「键盘顶着的时候也能改档」。
                不给这个值,ScrollView 会把键盘弹起时的第一下点击吃掉去收键盘 —— 现象是「点权限档没反应,
                要点两下」。 */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0 }}
            contentContainerStyle={st.chips}
          >
            <Chip
              tone={perm === 'full' ? 'full' : perm === 'readonly' ? 'readonly' : 'auto'}
              onPress={online ? () => setPermSheet(true) : undefined}
              disabled={!online}
            >
              {permissionModeLabel(perm)}
            </Chip>
            {/* ★从相册发图。`CAN_PICK` 为假(这个包里没有 expo-image-picker)时**整颗不摆** ——
                摆一个灰的等于说「这里有东西,只是现在不能点」,而真相是要重装一次新包才有。 */}
            {CAN_PICK ? (
              <Chip
                onPress={online && selected && !pickBusy ? () => void pickImage() : undefined}
                disabled={!online || !selected || pickBusy}
              >
                {pickBusy ? '🖼 正在存…' : '🖼 图片'}
              </Chip>
            ) : null}
            {/* 已经在工作流里就不再给启动入口 —— 一个会话同时只能在一条流上。 */}
            {!wf ? (
              <Chip onPress={online && selected ? () => router.push('/workflow') : undefined} disabled={!online || !selected}>
                / 工作流
              </Chip>
            ) : null}
            {/* 已转成附件的那几坨,排在 `/ 工作流` 后面。点一下删掉它(正文里的占位符不动)。 */}
            {attachments.map((a) => (
              <Chip key={a.path} onPress={() => dropAttachment(a)}>
                {`📎 ${a.name}`}
              </Chip>
            ))}
          </ScrollView>
          <View style={st.entry}>
            {/* ★输入框和它右下角那颗 ⤢ 是**一个整体**,不是并排的两件东西。
                原来 ⤢ 是一颗 40×40 的 `IconBtn`,和输入框、发送键三个平摊这一行:
                连 gap 一起吃掉 48pt,390 宽的屏上输入框只剩 ~270,一行装不下几个字。
                挪进输入框自己的地盘后这 48pt 全还给了正文,而**发送/停止键一点没动** ——
                它忙时就地变成停止,是这一屏最紧急的动作,位置和尺寸都不许改。
                ★`paddingRight: 38` 是配套的、不是装饰:不留出这一段,长文本会从按钮**底下**穿过去。 */}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Field
                value={text}
                onChangeText={onType}
                selection={sel}
                onSelectionChange={(e) => {
                  caretRef.current = e.nativeEvent.selection.start
                  // 受控只维持到原生真的把光标挪过去为止,立刻交还(理由见 `sel` 的声明处)。
                  if (sel) setSel(undefined)
                }}
                placeholder={online ? '给代理下达任务…' : '未连接 · 发不出去'}
                multiline
                editable={online && !!selected}
                style={{ minHeight: 44, maxHeight: 108, paddingRight: 38 }}
              />
              {/* ★全屏编辑入口。本体 28×28 + `hitSlop={8}` = **44×44** 的可点区域,正好压到最小触达,
                  而多出去的 8pt 刚好贴着按钮边缘 —— 再撑大就会从输入框右下角把「点这儿放光标」的
                  点击抢走(那一带正是长文本落笔的地方)。
                  ★不自动弹出:字数超阈值就抢焦点,会在人正在打字时把光标薅走。只认这一下点击。 */}
              <Pressable
                onPress={online && selected ? () => setBigEditor(true) : undefined}
                disabled={!online || !selected}
                hitSlop={8}
                style={({ pressed }) => [
                  st.expand,
                  { borderColor: c.border2, backgroundColor: c.bg2 },
                  pressed && { backgroundColor: c.surface2 },
                  (!online || !selected) && { opacity: 0.35 },
                ]}
              >
                <T style={{ fontSize: 13, lineHeight: 16, color: c.muted }}>⤢</T>
              </Pressable>
            </View>
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

      <BigEditor
        open={bigEditor}
        value={text}
        onCancel={() => setBigEditor(false)}
        onDone={(t) => {
          setText(t)
          setBigEditor(false)
        }}
      />

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
                      // ★写回**这条会话**。不写的话,退出对话屏再进来就被上面那个 effect
                      //  按服务端的旧值盖回去 —— 现象是「选了模型,回来又变回去了」。
                      //  失败不弹窗但要留痕:这是个偏好,丢了不致命,但静默失败会让人以为存上了。
                      if (selected) {
                        void invoke(CH.sessionSetModel, [{
                          workspacePath: selected.wsPath,
                          sessionId: selected.sessionId,
                          agentId: a.id,
                          modelId: mm.id,
                        }]).catch((e: unknown) => setNotice(e instanceof Error ? e.message : String(e)))
                      }
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
  // ⤢:贴在输入框右下角(而不是排在行里),右下是因为多行输入时光标就在那一带,手指不用跑。
  expand: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    width: 28,
    height: 28,
    borderRadius: RADIUS.chip,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  // ★不带 `flexWrap`:这一行现在是一条横向滚动的轨道(见上面那段注释),换行会让它变回原来那个
  //  「多一个 chip 就多一行、输入区跟着长高」的东西。`alignItems: 'center'` 让高矮不一的 chip
  //  居中对齐而不是各自拉满 —— 这里也是**整条轨道高度的来源**,别把这份样式清空。
  chips: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, paddingTop: 9, paddingBottom: 7 },
  // 斜杠命令面板。和「转成附件?」那一条同一套外框(bg2 + border2 + chip 圆角),
  // 好让输入区上方这一叠附加信息看起来是同一类东西,而不是各画各的。
  slash: { marginHorizontal: 12, marginTop: 9, borderRadius: RADIUS.chip, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  // 一条命令。纵向 9+9 加上两行文字 ≈ 48pt —— 这是个要用拇指点的列表,
  // 别再退回「一行小字」那种点不中的东西(`CopyBtn.tsx` 顶部那段就是为这个写的)。
  slashRow: { paddingHorizontal: 11, paddingVertical: 9 },
  // 「转成附件?」那一条。整条可点,所以纵向留够 —— 两行文案时高度自然到 44 上下。
  offload: {
    marginHorizontal: 12,
    marginTop: 9,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: RADIUS.chip,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
