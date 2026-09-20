/**
 * 「这条会话该用哪个代理和哪个模型」——**唯一**的判据。
 *
 * ★为什么单独一个文件:2026-08-28 把「代理 · 模型」从输入框上方的 chip 挪到了对话屏顶栏。
 *  chip 在那儿的时候,它是不是跟着会话走没人看得出来;搬到顶栏之后它**常驻显示**,
 *  切一趟会话就复位会非常显眼。而这几条判据全是**静默出错**型的:
 *  代理被卸载了还照着显示 → 顶栏写着一个不存在的代理名、发送键看着是活的、一发就报错;
 *  模型名升级换了 → 同理。它们长在 `chat.tsx` 里的话一条测试都写不了
 *  (`mobile` 那个 vitest project 是 node 环境,加载不了 `.tsx`)。
 *
 * ★服务端**早就**每条会话各存一份了(`ChatSession.agentId` / `.modelId`,
 *  `session:set-model` 也一直在方法表里)。手机端在这之前既不读也不写 —— 这次接上。
 *
 * ★零 RN import。
 */

/** 只取我们真正用到的那两个字段(故意不 import `useAgents` 的类型:那条链上挂着 RN)。 */
export type AgentLite = { id: string; models: { id: string }[] }

export type AgentPick = { agentId: string | null; modelId: string | null }

/**
 * 在一个代理的模型清单里挑一个:记着的那个还在就用它,否则退到它自己的**第一个**。
 *
 * ★★两处在用同一条规则 —— 这里的 `pickSessionAgent`(算「该用哪个」)和 `chat.tsx` 顶栏
 *  (把 id 换回那条模型对象拿去显示)。各写一份的话,漂移出来的样子是**顶栏显示的模型
 *  和真正发出去的那个不是同一个** —— 屏幕上一切正常,没有任何一条报错。
 * ★泛型是为了让调用方拿回自己那份完整的模型对象(顶栏要 `label`),不被这里的最小类型截断。
 */
export function pickModel<M extends { id: string }>(
  models: readonly M[] | undefined | null,
  modelId: string | null | undefined,
): M | null {
  return models?.find((m) => m.id === modelId) ?? models?.[0] ?? null
}

export function pickSessionAgent(
  session: { agentId?: string; modelId?: string } | null,
  agents: readonly AgentLite[],
): AgentPick {
  if (!agents.length) return { agentId: null, modelId: null }
  // ★会话记的那个代理**还在不在**。不在就退到第一个装了的 —— 卡在一个装不上的代理上,
  //  屏幕看起来一切正常,一发消息才炸。
  const agent = agents.find((a) => a.id === session?.agentId) ?? agents[0]
  // ★同理:代理还在但模型名变了(升级换了名字),保住代理、模型退到它自己的第一个。
  //  两级各退各的,别因为模型没了就把代理也一起换掉。
  const model = pickModel(agent.models, session?.modelId)
  return { agentId: agent.id, modelId: model?.id ?? null }
}

/**
 * 「顶栏这次要不要重新判一遍代理/模型」的守卫。
 *
 * ★为什么需要它:2026-08-29 review 抓到的竞态 —— `chat.tsx` 原来拿 `currentSession`(从
 *  `groups` 里按 id 查出来的那个会话对象)的**对象身份**当 `useEffect` 依赖。而
 *  `store.tsx` 的 `sessionsChanged` 处理器是**整份数组替换**,不是按 id 打补丁:哪怕只是
 *  **隔壁**一条会话跑完一轮广播了一次,这个工作区下所有会话(包括正显示在顶栏上的这条)
 *  都会换成新对象,identity 变了,effect 就重触发一次。如果那次广播的快照
 *  比用户刚点的 `session:set-model` 写回还旧,`pickSessionAgent` 就会拿着旧值把用户刚选的
 *  模型悄悄判掉 —— 正是写回那句注释在防的「选了又变回去」,只是从**读**的一侧发生。
 *
 * ★真正该触发重判的是**切会话本身**,不是「会话列表这份快照又换了个对象」。但只按会话
 *  identity(`key`)门控又会撞上另一条竞态:`agents`(`agents:detect`)和 `groups`
 *  (`workspaces:list` + 逐个 `session:list`)不是同时到的。如果这条会话的真实数据
 *  (`hasSession`)还没读到就先落了一次默认值、并把这次当成「判过了」,那么真实数据到了之后
 *  就再也不会补判 —— 顶栏永远停在启动时的默认代理上。
 *
 * ★两条都管:
 *  · 同一条会话,上次判的时候数据没到齐(`!prev.settled`)→ 这次到齐了照样要判一次。
 *  · 同一条会话,已经拿着完整数据判过一次(`prev.settled`)→ 后面随便什么原因重渲染
 *    (隔壁会话的广播、或者自己这次写回自己的回声)都不再判 —— 这是刻意接受的取舍:
 *    换来的代价是「电脑端在这一屏开着的时候把这条会话的模型从别处改了,顶栏不会实时跟着变」,
 *    比「用户自己刚选的模型被静默判掉」轻得多。
 */
export type DeriveState = { key: string | null; settled: boolean }

export function shouldRederive(
  prev: DeriveState | null,
  next: { key: string | null; hasSession: boolean; hasAgents: boolean },
): boolean {
  if (!prev) return true
  if (prev.key !== next.key) return true
  const nowSettled = next.hasSession && next.hasAgents
  return !prev.settled && nowSettled
}
