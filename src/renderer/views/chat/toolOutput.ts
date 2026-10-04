import { createContext } from 'react'

export interface ToolOutputApi {
  /** 取一条工具调用的完整输出。失败就抛 —— 调用处要把失败**说出来**,不能静默空白。 */
  load: (messageId: string, toolId: string) => Promise<string>
}

/**
 * 大段工具输出怎么按需取回来。由 WorkspaceView 提供(只有它知道当前是哪个工作区、哪条会话)。
 *
 * ★★为什么要按需取(2026-10-03 用户报「点开会话都要加载一下」):剖了用户那个 1.2MB 的真会话 ——
 *  98 条消息里 **90% 的字节是 `tools[].output`**(shell stdout、读文件回显),而这些卡
 *  **默认是折叠的**,下载下来只为了立刻藏起来。省掉之后同一个会话 1229KB → 197KB。
 *  手机端 2026-09-04 就是这么解决的(`main/chat/toolOutputCap.ts`),电脑端当初特意
 *  「行为逐字不变」没做 —— 结果慢的是天天在用的那条路。
 * ★和 OpenFileCtx 同一个路子:走 context 而不是逐层传 prop(ToolBlock 埋在 Message 底下),
 *  且**拿不到 ctx 时不许装作没有输出** —— 那和「这条工具真的没输出」长得一模一样。
 */
export const ToolOutputCtx = createContext<ToolOutputApi | null>(null)

/**
 * 电脑端拉历史时给服务端的上限。★只开「整段不下发」这一道,**不开截断**。
 *
 * ★★`omitOver: 4KB` —— 超过 4KB 的工具输出不跟着历史走,点开那一行再单独取。
 *  实测用户那个 1.2MB 的真会话:1229KB → 197KB(省 84%),154 段输出里 66 段改成按需取。
 *  阈值取 4KB 不取手机端的 1KB:电脑上这一次往返是本机 IPC(毫秒级),但 4KB 以内的输出
 *  直接内联就**一次往返都不用等**,而它们加起来也才几十 KB。
 * ★`lines`/`bytes` 给得足够大 = 内联的那些**一个字都不截**。
 *  readCap 要求 lines 必须是个 ≥1 的数才认这份上限,所以不能省;给大数的意思是
 *  「我只要按需取,不要截断」—— 电脑端屏幕画得下,静默截断没有理由。
 */
export const DESKTOP_TOOL_OUTPUT_CAP = { toolOutputLines: 1_000_000, toolOutputBytes: 1_000_000, toolOutputOmitOver: 4096 } as const
