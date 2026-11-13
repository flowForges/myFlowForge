// 会话里每轮一块的电脑操作记录(spec §10.5)。行 = 64px 缩略图 + 时间 + 动作 + 目标 app + 结果 chip;缩略图按需取,点开用 Lightbox。
// 输入的文字只出现在批准卡上,这里只写 `输入 N 字`(不展示预览)。
// actionLog.thumb() 回的是裸 base64:这里自己拼 data URL,且只认纯 base64,别的值(https: 等)一律丢掉。
import { useEffect, useRef, useState } from 'react'
import { CU_ERR, CU_KIND_LABEL } from '@shared/computerUse'
import type { CuLogEntry } from '../../../main/computerUse/types'
import { Lightbox } from '../../components/Lightbox'
import { fmtPt, screenName } from './cuFormat'

const OP_LABEL: Record<string, string> = {
  ...CU_KIND_LABEL, screenshot: '截图', wait: '等待', cursor: '光标位置', front_app: '前台应用',
}
const RESULT_LABEL: Record<CuLogEntry['result'], string> = { allowed: '已允许', auto: '自动', denied: '已拒绝', blocked: '已拦截', failed: '失败' }

const two = (n: number) => String(n).padStart(2, '0')
const clock = (ts: number) => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}` }

function describe(en: CuLogEntry): string {
  const label = OP_LABEL[en.op] ?? en.op
  switch (en.op) {
    case 'type': return en.textLen != null ? `${label} ${en.textLen} 字` : label
    case 'key': return en.combo ? `${label} ${en.combo}` : label
    case 'click': case 'move': case 'scroll': return en.at ? `${label} ${fmtPt(en.at)}` : label
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

export function CuLogBlock({ entries, thumb }: { entries: CuLogEntry[]; thumb: (file: string) => Promise<string | null> }) {
  const [big, setBig] = useState<string | null>(null)
  if (!entries.length) return null
  const turns: { turn: number; rows: CuLogEntry[] }[] = []
  for (const en of entries) {
    const last = turns[turns.length - 1]
    if (last && last.turn === en.turn) last.rows.push(en)
    else turns.push({ turn: en.turn, rows: [en] })
  }
  return (
    <>
      {turns.map((t, ti) => (
        <div className="cu-log" key={`${t.turn}-${ti}`}>
          <div className="cu-log-head">电脑 · {t.rows.length} 步</div>
          {t.rows.map((en, i) => (
            <div className="cu-log-row" key={`${en.ts}-${i}`}>
              {en.thumb ? <Thumb file={en.thumb} load={thumb} onOpen={setBig} /> : <span className="cu-thumb-slot" />}
              <span className="cu-time">{clock(en.ts)}</span>
              <span className="cu-act">{describe(en)}</span>
              {en.app && <span className="cu-app">{screenName(en.app)}</span>}
              <span className={`cu-chip cu-res cu-res-${en.result}`} title={en.code ? CU_ERR[en.code] : undefined}>{RESULT_LABEL[en.result]}</span>
            </div>
          ))}
        </div>
      ))}
      {big && <Lightbox src={big} onClose={() => setBig(null)} />}
    </>
  )
}
