import type { ReactNode } from 'react'

export type ChipTone = 'ok' | 'bad' | 'warn' | 'muted'

/** 状态块。不是句子 */
export function Chip({ tone = 'muted', title, children }: { tone?: ChipTone; title?: string; children: ReactNode }) {
  return <span className={`mffai-badge mffai-chip ${tone}`} title={title}>{children}</span>
}
