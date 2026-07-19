import type { ChatMessage } from '@shared/types'

// P1-1: extracted from WorkspaceView.tsx (Task 2 of the run2 rework) — single source of truth for
// turning the current conversation into a plain-text transcript that pre-seeds the workflow launch
// gate's requirement textarea. Pure — caps at the last 12 messages (enough context without dragging
// in a whole long session); empty conversation → ''.
export function buildConversationSeed(messages: Pick<ChatMessage, 'who' | 'text'>[]): string {
  return messages
    .slice(-12)
    .map((m) => `${m.who === 'ai' ? 'AI' : '我'}: ${m.text}`)
    .join('\n\n')
}
