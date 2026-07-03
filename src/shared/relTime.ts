// Relative "last activity" label for the workspace list: 刚刚 / N 分钟前 / N 小时前 / 昨天 / 前天 / date.
// `ms` is the epoch-millis of the last activity, `now` the current epoch-millis (injected for testing).
// Returns '' when there is no activity (ms falsy / <= 0). Day buckets (昨天/前天) use calendar days, not
// 24h windows, so an event at 23:50 reads as 昨天 just after midnight rather than "X 小时前".
function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}` }

// Legacy "HH:MM:SS"/"HH:MM" clock-only timestamps: older builds stored `now()` as
// new Date().toISOString().slice(11,19), i.e. the UTC clock with NO date. We can't re-date them, but we CAN
// timezone-correct: parse the clock as UTC-of-an-arbitrary-day, then read it back in local time. Returns
// {h,m,s} in LOCAL time, or null if `ts` isn't a bare clock string.
function legacyClockLocal(ts: string): { h: number; m: number; s: number } | null {
  const mt = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(ts)
  if (!mt) return null
  const u = new Date(Date.UTC(1970, 0, 1, +mt[1], +mt[2], mt[3] ? +mt[3] : 0))
  return { h: u.getHours(), m: u.getMinutes(), s: u.getSeconds() }
}

// Chat message timestamp label. `ts` is an ISO timestamp — rendered in LOCAL time, with a date prefix for
// older days: today → just HH:MM; 昨天/前天 → prefix + HH:MM; older → date + HH:MM (M月D日, or YYYY/M/D
// across years). Legacy UTC clock-only values (no date) are timezone-corrected to local HH:MM via
// legacyClockLocal — they can't be re-dated, so they always render as bare HH:MM.
export function fmtMsgTime(ts: string, nowMs: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) {
    const lc = legacyClockLocal(ts)
    if (lc) return `${pad2(lc.h)}:${pad2(lc.m)}`
    return ts.length >= 5 ? ts.slice(0, 5) : ts
  }
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const n = new Date(nowMs)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000)
  if (dayDiff <= 0) return hm
  if (dayDiff === 1) return `昨天 ${hm}`
  if (dayDiff === 2) return `前天 ${hm}`
  const date = d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
  return `${date} ${hm}`
}

// Full local date+time for a message timestamp — used as the hover `title` so the exact day is always
// reachable even when the compact label shows only HH:MM (today's messages, or legacy clock-only records).
// Parseable ISO → "YYYY-MM-DD HH:MM:SS" local; legacy clock-only → local "HH:MM:SS · 旧记录·日期未知".
export function fmtMsgTimeFull(ts: string): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (!isNaN(d.getTime())) {
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  }
  const lc = legacyClockLocal(ts)
  if (lc) return `${pad2(lc.h)}:${pad2(lc.m)}:${pad2(lc.s)} · 旧记录·日期未知`
  return ts
}

export function fmtRelTime(ms: number, now: number): string {
  if (!ms || ms <= 0) return ''
  const diff = now - ms
  if (diff < 60_000) return '刚刚'                              // < 1 min (also covers small clock skew)
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(ms)
  const n = new Date(now)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayDiff = Math.round((startOfDay(n) - startOfDay(d)) / 86_400_000)
  if (dayDiff <= 0) return `${Math.floor(diff / 3_600_000)} 小时前`  // earlier today
  if (dayDiff === 1) return '昨天'
  if (dayDiff === 2) return '前天'
  return d.getFullYear() === n.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}
