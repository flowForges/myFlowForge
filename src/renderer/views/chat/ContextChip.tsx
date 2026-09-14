import { useEffect, useRef, useState } from 'react'
import type { ContextUsage } from '@shared/types'

/**
 * 输入框里那枚「上下文」。
 *
 * ★★这里的每一个数都必须是**各家 CLI 自己报的**。用户 2026-09-14 原话:「上下文要真实,
 *  从官方自己的能力里取的,不能是你自己计算的,那个不准确」。
 *
 * ★形态是一枚**圆环小图标**,数字全在点开的 tips 里(用户 2026-09-14:第一版把
 *  「上下文 30.3K / 1.00M 3%」整条摊在输入框上,「太丑了…可以做一个圆环?满了就是红的」)。
 *
 * ★两种环,**绝不互相冒充**:
 *  · CLI 报了窗口 → 实心进度环,按占比填充,70% 转黄、90% 转红
 *  · CLI 没报窗口 → **虚线环**(表示「不知道占了多少」),不画任何填充
 *  以前是按模型名硬猜一个 200K 算出百分比 —— 那个数看着很像回事,却从来没人核对过。
 *  画一个满环或空环去冒充「已知」,和编一个百分比是同一种错。
 */

/** 12345 → "12.3K";1234567 → "1.23M"。小于 1000 原样。 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export interface ContextChipProps {
  usage?: ContextUsage
  /** 数据来自哪个编码代理,tips 里要说出来 —— 一条会话里可能换过 provider。 */
  providerLabel?: string
}

/** 环的半径与周长。r=9 在 24 视口里留得下 3px 描边,视觉上是个 18px 的小图标。 */
const R = 9
const C = 2 * Math.PI * R

export function ContextChip({ usage, providerLabel }: ContextChipProps) {
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
  /**
   * ★★★「已用 > 窗口」是**物理上不可能的**:占用量就是最近一次请求塞进去的 token,它不可能比
   *  窗口还大(超了那次请求根本发不出去)。出现这种数只可能是两个数不是一回事 —— 我们算错了、
   *  或者读到的是一个旧版本写下的值。
   *
   *  2026-09-14 用户截图:`已用 794,430 / 窗口 200,000 / 占用 100%`。第一版的 bug 是把
   *  cachedInputTokens(inputTokens 的子集)又加了一遍;公式已修,但**界面当时照样把它画成了
   *  100%** —— 那才是更该修的地方:一个显然不可能的数,界面不该替它圆场。
   *
   *  所以这里不 clamp 成 100%,而是**判定窗口不可信**:退回「未知」那一档(虚线环、不显示占比),
   *  并在 tips 里明说两个数对不上。宁可说「我不知道」,也不能给一个假的满格。
   */
  const trustworthy = win != null && win > 0 && used <= win
  const pct = trustworthy ? Math.round((used / win!) * 100) : null
  const inconsistent = win != null && win > 0 && used > win
  // 三档颜色。★用户原话:「满了就是红的」。90% 起转红 —— 那时候再不压缩就要被自动截断了。
  const tone = pct == null ? '' : pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : ''

  return (
    <div className="ctx-chip-wrap" ref={ref}>
      <button
        type="button"
        className={`ctx-ring-btn${tone ? ' ' + tone : ''}`}
        title={pct != null ? `上下文 ${pct}%（${fmtTokens(used)} / ${fmtTokens(win!)}）` : `上下文 ${fmtTokens(used)}（该 CLI 未上报窗口大小）`}
        aria-label={pct != null ? `上下文已用 ${pct}%` : `上下文 ${used} tokens`}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        {/* ★圆环:一眼看出「还剩多少」,不占一整条文案的宽度(用户 2026-09-14:「这个样式的效果
            也太差了…可以做一个圆环?满了就是红的」)。数字全部收进 tips。 */}
        <svg viewBox="0 0 24 24" className="ctx-ring" aria-hidden="true">
          <circle className="ctx-ring-track" cx="12" cy="12" r={R} fill="none" strokeWidth="3" />
          {pct != null ? (
            <circle
              className="ctx-ring-fill" cx="12" cy="12" r={R} fill="none" strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - pct / 100)}
              /* 12点方向起画,顺时针 —— 和所有人对「进度环」的直觉一致 */
              transform="rotate(-90 12 12)"
            />
          ) : (
            /* ★窗口未知:画一段虚线表示「不知道占了多少」,而不是画一个满环或空环冒充已知。 */
            <circle className="ctx-ring-unknown" cx="12" cy="12" r={R} fill="none" strokeWidth="3" strokeDasharray="2 3" />
          )}
        </svg>
      </button>

      {open && (
        <div className="ctx-tip" role="dialog" aria-label="上下文明细">
          <div className="ctx-tip-row"><span>已用</span><b>{used.toLocaleString()}</b></div>
          <div className="ctx-tip-row">
            <span>窗口</span>
            {/* ★窗口未知时**明说**,而不是留白让人以为是 bug —— 也不能填一个猜的数。 */}
            <b>{win ? win.toLocaleString() : '未知'}</b>
          </div>
          {pct != null && <div className="ctx-tip-row"><span>占用</span><b>{pct}%</b></div>}
          <p className="ctx-tip-note">
            {providerLabel ? `${providerLabel} ` : ''}上报的最近一次请求的输入 token。
            {!win && ' 该 CLI 没有上报上下文窗口大小，所以这里不显示占比 —— 我们不猜。'}
          </p>
          {inconsistent && (
            <p className="ctx-tip-why">
              已用比窗口还大，这两个数对不上（不可能真的发生）—— 多半是上一轮跑在旧版本上留下的记录。
              下一轮跑完就会刷新；在那之前这里不显示占比。
            </p>
          )}
          {/* ★★这里曾经是一颗「压缩上下文」按钮。2026-09-14 撤掉:codex 那条协议路径在实验室里
              跑得通(thread/compact/start,实测 8.6 秒),到用户机器上就是不成 —— 很可能是 PATH 上的
              codex 和我实测那个不是同一个版本。一个**时灵时不灵**的按钮比没有按钮更糟:它让人以为
              压过了。各家 CLI 本来就会在接近上限时自己压,那就交给它们,我们只如实显示数字。 */}
          <p className="ctx-tip-auto">接近上限时，CLI 会自动压缩历史。</p>
        </div>
      )}
    </div>
  )
}
