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
  const model = agent.models.find((m) => m.id === session?.modelId) ?? agent.models[0]
  return { agentId: agent.id, modelId: model?.id ?? null }
}
