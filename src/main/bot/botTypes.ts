// Platform-agnostic types for the bot bridge. Each chat platform (DingTalk today; Telegram/Feishu
// later) implements BotTransport; the bridge core in botBridge.ts speaks only these types so it never
// knows which platform it is driving.

import type { BotStatus } from '@shared/types'
export type { BotStatus }

export type BotPlatform = 'dingtalk' | 'telegram' | 'feishu'

export type BotChatType = 'private' | 'group'

// Where a message came from / where to send one. `chatId` is the platform's stable conversation id
// (a DingTalk conversationId). For 1:1 DingTalk chats we also need the recipient's userId to push
// proactively, so it rides along as `userId`.
export interface BotAddress {
  platform: BotPlatform
  chatId: string
  chatType: BotChatType
  userId?: string        // recipient staff id (DingTalk 1:1 proactive push)
  robotCode?: string     // DingTalk robotCode for proactive push
  replyWebhook?: string  // DingTalk sessionWebhook — cheap reply path, ~5min TTL
}

export interface InboundBotMessage {
  platform: BotPlatform
  chatId: string
  chatType: BotChatType
  senderId: string
  senderName: string
  text: string
  address: BotAddress    // pre-built reply address for this message
}

export type OutboundBotMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; title: string; text: string; actions?: { key: string; label: string }[] }

// A chat platform connection. Core stays platform-agnostic behind this.
export interface BotTransport {
  readonly platform: BotPlatform
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(cb: (m: InboundBotMessage) => void): void
  onStatus(cb: (s: BotStatus) => void): void
  send(to: BotAddress, msg: OutboundBotMessage): Promise<void>
}

// ---- persisted bridge config (lives in app settings, NEVER in source/git) ----

export type BotVerbosity = 'essential' | 'stages' | 'verbose'

export interface BotFocus { workspacePath: string; sessionId: string }

export interface BotBinding {
  platform: BotPlatform
  chatId: string
  chatType: BotChatType
  userId?: string
  robotCode?: string
  focus: BotFocus | null   // currently attached ws/session for this chat
  boundAt: number
}

export interface DingtalkCreds { clientId: string; clientSecret: string }

export interface BotBridgeConfig {
  enabled: boolean
  dingtalk: DingtalkCreds
  verbosity: BotVerbosity
  pairingCode: string
  bindings: BotBinding[]
  // idRegistry state: monotonic seq + assigned maps (persisted so ids never reshuffle across restarts)
  ids: { seq: number; ws: Record<string, string>; session: Record<string, string> }
}

export function defaultBotConfig(): BotBridgeConfig {
  return {
    enabled: false,
    dingtalk: { clientId: '', clientSecret: '' },
    verbosity: 'essential',
    pairingCode: '',
    bindings: [],
    ids: { seq: 0, ws: {}, session: {} },
  }
}
