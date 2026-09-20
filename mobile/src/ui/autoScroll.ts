/**
 * 「这一次该不该落到底、要不要带动画」。
 *
 * ★为什么要一个状态机而不是一行 `scrollToEnd({animated:true})`:
 *  真机验收当场报的「进会话时历史哗哗刷一遍才落到最后一条」就是那一行。`animated: true`
 *  对**每一次**变化都生效,而进屏那一次是 0 → N —— RN 真的会把整个内容高度 animate
 *  一遍,人看到的是历史从头滚到尾。第一次必须瞬间到位。
 *
 * ★★**为什么不能只看消息条数(这是上一版的 bug,用户原话「如果 LLM 在一直输出,页面应该一直
 *  滚动,一直看到最新的结果」)**:一轮回答从头到尾**就是一条消息**。`assistant-start` 落下那
 *  一条之后,后面几百片 `assistant-delta` 只是把**同一条**的 `text` 越接越长 —— 条数一动不动。
 *  上一版拿 `count` 当唯一判据,于是「数量没变就不滚」这条规则把整轮流式输出全挡在门外:
 *  内容在屏幕下方一直长,视口一动不动。所以现在还要看**最后一条的正文长度**(`tail`)。
 *  用长度不用内容本身:每来一片都做一次字符串比较是白花钱,而长度变了就一定是内容变了。
 *  (`assistant-replace` 会把正文整段换掉,长度多半也变;万一换成等长的那一次不滚,
 *   下一片就补上了 —— 判错的代价必须是「晚一拍」,不能是「把人拽走」。)
 *
 * ★★**滚到一半的人不许被拽回去。**人往上翻是在读东西,自动落底在这时候就是抢方向盘 ——
 *  比不自动滚**糟得多**。所以 `atBottom` 是一道硬闸门:离了底就停,回到底就继续。
 *  唯一的例外是**第一次落底**(`armed`):那一刻人还没滚过任何东西,视口就在 0,
 *  拿 `atBottom` 去判反而会把「进屏落到最后一条」整个吃掉(内容比一屏高时它一开始就是假)。
 *
 * ★这个文件刻意**不 import 任何东西**(和 `sessionStatus.ts` 同一个理由):它只吃三个纯值,
 *  所以能在 node 环境里单测 —— vitest 的 mobile project 跑不了 import react-native 的文件。
 *
 * `armed` = 「下一次有内容时要瞬间到位」。换会话时 `useChat` 会把 msgs 清回 0
 * (见 `useChat.ts` 的「换会话就清空」),这里据此重新武装 —— 否则第二次进别的会话
 * 又会哗哗刷一遍。
 */
export type AutoScrollState = {
  /** 下一次落底要不要瞬间到位(true = 还没落过底) */
  armed: boolean
  /** 上一次看到的消息条数 */
  count: number
  /** 上一次看到的**最后一条**消息的正文长度。流式吐字时只有它在变。 */
  tail: number
}

/** 这一帧的消息流长什么样,以及人现在是不是贴着底。 */
export type FlowShape = {
  count: number
  tail: number
  /** 视口是不是还贴着内容底部(由 `atBottom()` 从 onScroll 的三个数算出来) */
  atBottom: boolean
}

export const initialAutoScroll = (): AutoScrollState => ({ armed: true, count: 0, tail: 0 })

/**
 * 「贴着底」的判据:内容底部离视口底部还有多少。
 *
 * ★留一道 24pt 的余量,不是判等于 0:iOS 的橡皮筋回弹、四舍五入到像素、内容高度这一帧
 *  刚长了一点点 —— 这几样都会让「人明明就在底下」量出个几 pt 的差。差一点就判成「离开了」
 *  的话,流式输出会自己把自己停掉。24 也远小于「人真的往上翻了一段」的距离(随手一划就是几百 pt),
 *  所以不会把「我在读上面」误判成「我在底下」。
 */
export const BOTTOM_SLACK = 24

export function atBottom(m: { contentH: number; offsetY: number; viewH: number }): boolean {
  return m.contentH - (m.offsetY + m.viewH) <= BOTTOM_SLACK
}

export function nextScroll(
  s: AutoScrollState,
  f: FlowShape,
): { state: AutoScrollState; scroll: false | { animated: boolean } } {
  // 空了 = 换会话(或者还没拉到历史)。重新武装,并且不滚 —— 空会话滚一下只会闪一下。
  if (f.count === 0) return { state: { armed: true, count: 0, tail: 0 }, scroll: false }
  // 条数和末条长度都没变:这一次重渲染和消息流无关(改了权限档、弹了个 sheet……)。
  // 滚了会把正在往上翻历史的人拽回底部。
  if (f.count === s.count && f.tail === s.tail) return { state: s, scroll: false }
  const state: AutoScrollState = { armed: false, count: f.count, tail: f.tail }
  // ★首帧不看 atBottom(理由见文件头):这一刻人还没滚过,视口就在 0。
  if (s.armed) return { state, scroll: { animated: false } }
  // 人自己翻上去了 —— 停止跟随。**状态照样往前推**:等他滑回底部时,是从「现在这份内容」
  // 接着跟,而不是补一次跳到底的追赶动画(那一下同样是抢方向盘)。
  if (!f.atBottom) return { state, scroll: false }
  return { state, scroll: { animated: true } }
}
