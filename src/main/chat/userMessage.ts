import type { ChatMessage } from '@shared/types'

let seq = 0

/**
 * 一轮里「用户说的那句话」落盘时长什么样。正常发车(chatService.sendTurn)和发车前就被拒的那条路
 * (ipc/handlers.ts 的 runTurn,见 §4.3)用的是同一份。
 *
 * ★★为什么要单独拎出来(2026-10-07):被拒的那一轮原来**只记了一条系统提示**,用户的原文根本没落盘 ——
 *  从手机或机器人发来的那句话就凭空消失了,电脑上只看到「⛔ 这一轮没有发出」,不知道没发出的是什么。
 * ★放在独立的小模块而不是 chatService 里:好几个测试把 chatService 整个 mock 掉了,
 *  放进去的话那些测试拿到的是 undefined。
 * ★`via`(从哪台设备发来的)照样带上,但它**从不**混进发给模型的提示词 —— 两个字段,从不相加。
 */
export function userMessageOf(p: { text: string; attachments?: ChatMessage['files']; via?: string }): ChatMessage {
  return {
    id: `u-${Date.now()}-${++seq}`, who: 'user', text: p.text,
    files: p.attachments?.length ? p.attachments : undefined, ts: new Date().toISOString(),
    ...(p.via ? { via: p.via } : null),
  }
}
