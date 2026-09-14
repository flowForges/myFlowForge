import { useEffect, useRef, useState } from 'react'
import type { ContextUsage } from '@shared/types'

/**
 * 输入框里那枚「上下文」。
 *
 * ★★这里的每一个数都必须是**各家 CLI 自己报的**。用户 2026-09-14 原话:「上下文要真实,
 *  从官方自己的能力里取的,不能是你自己计算的,那个不准确」。
 *
 * ★所以有两种形态,而且**绝不互相冒充**:
 *  · CLI 报了窗口 → `45.2K / 272K · 17%` + 一条占比细线
 *  · CLI 没报窗口 → 只有 `45.2K`,不画线、不写百分比
 *  以前是按模型名硬猜一个 200K 算出百分比 —— 那个数看着很像回事,却从来没人核对过。
 *  宁可少显示一半信息,也不要显示一半假信息。
 */

/** 12345 → "12.3K";1234567 → "1.23M"。小于 1000 原样。 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export interface ContextChipProps {
  usage?: ContextUsage
  /** 这个 provider / 通路能不能压缩。不能的话按钮置灰,并用 compactHint 说清为什么。 */
  canCompact: boolean
  compactHint?: string
  onCompact: () => void | Promise<void>
  /** 正在压缩(父层维护,因为压缩期间输入框整体要有反馈)。 */
  compacting?: boolean
  /** 数据来自哪个编码代理,tips 里要说出来 —— 一条会话里可能换过 provider。 */
  providerLabel?: string
}

export function ContextChip({ usage, canCompact, compactHint, onCompact, compacting, providerLabel }: ContextChipProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点别处关掉。★不用 onBlur:浮层里有按钮,点按钮会先触发 blur 把它关了,于是那颗按钮永远点不到。
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', off)
    return () => document.removeEventListener('mousedown', off)
  }, [open])

  // 一个 token 都没拿到 = 这个 provider 没报过用量。不占地方,也不显示一个 0。
  if (!usage || usage.used <= 0) return null

  const { used, window: win } = usage
  const pct = win && win > 0 ? Math.min(100, Math.round((used / win) * 100)) : null

  return (
    <div className="ctx-chip-wrap" ref={ref}>
      <button
        type="button"
        className={`ctx-chip${pct != null && pct >= 80 ? ' hot' : ''}`}
        title="点开看明细 / 压缩上下文"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className="ctx-chip-label">上下文</span>
        <b>{fmtTokens(used)}</b>
        {pct != null && <><span className="ctx-chip-sep">/</span><span>{fmtTokens(win!)}</span><span className="ctx-chip-pct">{pct}%</span></>}
        {pct != null && <span className="ctx-chip-bar"><i style={{ width: `${pct}%` }} /></span>}
      </button>

      {open && (
        <div className="ctx-tip" role="dialog" aria-label="上下文明细">
          <div className="ctx-tip-row">
            <span>已用</span><b>{used.toLocaleString()}</b>
          </div>
          <div className="ctx-tip-row">
            <span>窗口</span>
            {/* ★窗口未知时**明说**,而不是留白让人以为是 bug —— 也不能填一个猜的数。 */}
            <b>{win ? win.toLocaleString() : '未知'}</b>
          </div>
          <p className="ctx-tip-note">
            {providerLabel ? `${providerLabel} ` : ''}上报的最近一轮输入侧 token（新输入 + 缓存读写，不含生成的内容）。
            {!win && ' 该 CLI 没有上报上下文窗口大小，所以这里不显示占比 —— 我们不猜。'}
          </p>
          <button
            type="button"
            className="ctx-tip-act"
            disabled={!canCompact || compacting}
            title={canCompact ? '让 CLI 把历史压缩成摘要' : compactHint}
            onClick={() => { void onCompact(); setOpen(false) }}
          >
            {compacting ? '压缩中…' : '压缩上下文'}
          </button>
          {!canCompact && compactHint && <p className="ctx-tip-why">{compactHint}</p>}
        </div>
      )}
    </div>
  )
}
