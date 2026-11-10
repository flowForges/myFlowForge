import type { ReactNode } from 'react'

export type ChipTone = 'ok' | 'bad' | 'warn' | 'muted' | 'run' | 'acc' | 'line'

/** 状态块。不是句子。dot:前面一个 6px 圆点(tone 'run' 时闪);sq:5px 圆角 */
export function Chip({ tone = 'muted', title, dot, sq, children }: { tone?: ChipTone; title?: string; dot?: boolean; sq?: boolean; children: ReactNode }) {
  return <span className={`mffai-badge mffai-chip ${tone}${dot ? ' dot' : ''}${sq ? ' sq' : ''}`} title={title}>{children}</span>
}
