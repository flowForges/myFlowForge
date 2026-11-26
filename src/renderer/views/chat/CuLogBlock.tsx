// 会话里每轮一块的电脑操作记录(spec §10.5)。rc3:块落在它那一轮的回复之后(见 cuAnchor.ts),表头点击折叠/展开。
//行 = 64px 缩略图 + 时间 + 动作 + 目标 app + 结果 chip;缩略图按需取,点开用 Lightbox。
// 输入的文字只出现在批准卡上,这里只写 `输入 N 字`(不展示预览)。
// actionLog.thumb() 回的是裸 base64:这里自己拼 data URL,且只认纯 base64,别的值(https: 等)一律丢掉。
import { useCallback, useEffect, useRef, useState } from 'react'
import { CU_ERR, CU_KIND_LABEL, ROLE_LABEL, visibleText } from '@shared/computerUse'
import type { CuLogEntry } from '../../../main/computerUse/types'
import { Lightbox } from '../../components/Lightbox'
import { fmtPt, screenName } from './cuFormat'

const OP_LABEL: Record<string, string> = {
  ...CU_KIND_LABEL, screenshot: '截图', wait: '等待', cursor: '光标位置', front_app: '前台应用',
}
const RESULT_LABEL: Record<CuLogEntry['result'], string> = { allowed: '已允许', auto: '自动', denied: '已拒绝', blocked: '已拦截', failed: '失败' }

/** spec §10: delivered_verified → 已确认; delivered_unverified / delivered_without_effect / uncertain → 未确认;
 *  no delivery (reads, v1 ops, a refusal before anything ran) → the usual result chip. */
function resultChip(en: CuLogEntry): string {
  switch (en.delivery) {
    case 'delivered_verified': return '已确认'
    case 'delivered_unverified': case 'delivered_without_effect': case 'uncertain': return '未确认'
    default: return RESULT_LABEL[en.result]
  }
}

const two = (n: number) => String(n).padStart(2, '0')
const clock = (ts: number) => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` }

function describe(en: CuLogEntry): string {
  const label = OP_LABEL[en.op] ?? en.op
  switch (en.op) {
    case 'type': return en.textLen != null ? `${label} ${en.textLen} 字` : label
    case 'key': return en.combo ? `${label} ${en.combo}` : label
    case 'click': case 'move': case 'scroll': return en.at ? `${label} ${fmtPt(en.at)}` : label
    case 'act': {
      const el = en.element
      const role = el ? (ROLE_LABEL[el.role] ?? '控件') : ''
      const name = el?.name ? `「${screenName(el.name)}」` : ''
      return [visibleText(en.actLabel ?? label), (role + name) || undefined].filter(Boolean).join(' ')
    }
    default: return label
  }
}

const B64 = /^[A-Za-z0-9+/=]+$/
const toDataUrl = (raw: string | null): string | null => (raw && B64.test(raw) ? `data:image/jpeg;base64,${raw}` : null)

function Thumb({ file, load, onOpen }: { file: string; load: (f: string) => Promise<string | null>; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let alive = true
    const go = () => { void load(file).then((s) => { if (alive) setSrc(toDataUrl(s)) }).catch(() => {}) }
    const el = ref.current
    // 只在行滚进视野时取;没有 IntersectionObserver 的环境直接取
    if (typeof IntersectionObserver === 'undefined' || !el) { go(); return () => { alive = false } }
    const io = new IntersectionObserver((hits) => { if (hits.some((h) => h.isIntersecting)) { io.disconnect(); go() } })
    io.observe(el)
    return () => { alive = false; io.disconnect() }
  }, [file, load])
  return (
    <span ref={ref} className="cu-thumb-slot">
      {src && (
        <button type="button" className="cu-thumb-btn" aria-label="放大" onClick={() => onOpen(src)}>
          <img className="cu-thumb" alt="" src={src} />
        </button>
      )}
    </span>
  )
}

/** 每块的展开状态:用户点过的记住(视图挂着期间),没点过的跟默认走(在跑的那轮展开,跑完的收起)。 */
export function useCuTurnOpen(): { isOpen(key: string, dflt: boolean): boolean; toggle(key: string, dflt: boolean): void } {
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const isOpen = useCallback((key: string, dflt: boolean) => picked[key] ?? dflt, [picked])
  const toggle = useCallback((key: string, dflt: boolean) => setPicked((m) => ({ ...m, [key]: !(m[key] ?? dflt) })), [])
  return { isOpen, toggle }
}

export function CuTurnBlock({ rows, open, onToggle, thumb }: { rows: CuLogEntry[]; open: boolean; onToggle: () => void; thumb: (file: string) => Promise<string | null> }) {
  const [big, setBig] = useState<string | null>(null)
  if (!rows.length) return null
  return (
    <div className="cu-log">
      <button type="button" className="cu-log-head" aria-expanded={open} onClick={onToggle}>
        <span>电脑 · {rows.length} 步</span>
        <span className={`cu-log-caret${open ? ' open' : ''}`} aria-hidden="true">▸</span>
      </button>
      {open && rows.map((en, i) => (
        <div className="cu-log-row" key={`${en.ts}-${i}`}>
          {en.thumb ? <Thumb file={en.thumb} load={thumb} onOpen={setBig} /> : <span className="cu-thumb-slot" />}
          <span className="cu-time">{clock(en.ts)}</span>
          <span className="cu-act">{describe(en)}</span>
          {en.app && <span className="cu-app">{screenName(en.app)}</span>}
          <span className={`cu-chip cu-res cu-res-${en.result}`} title={en.code ? CU_ERR[en.code] : undefined}>{resultChip(en)}</span>
        </div>
      ))}
      {big && <Lightbox src={big} onClose={() => setBig(null)} />}
    </div>
  )
}
