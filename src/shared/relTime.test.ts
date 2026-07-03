import { describe, it, expect } from 'vitest'
import { fmtRelTime, fmtMsgTime, fmtMsgTimeFull } from './relTime'

// Fixed "now": 2026-06-15 14:30:00 local time.
const NOW = new Date(2026, 5, 15, 14, 30, 0).getTime()
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi, 0).getTime()

describe('fmtRelTime', () => {
  it('returns empty string when there is no activity', () => {
    expect(fmtRelTime(0, NOW)).toBe('')
    expect(fmtRelTime(-1, NOW)).toBe('')
  })
  it('刚刚 for under a minute (and minor future skew)', () => {
    expect(fmtRelTime(NOW - 30_000, NOW)).toBe('刚刚')
    expect(fmtRelTime(NOW + 5_000, NOW)).toBe('刚刚')
  })
  it('N 分钟前 under an hour', () => {
    expect(fmtRelTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(fmtRelTime(NOW - 59 * 60_000, NOW)).toBe('59 分钟前')
  })
  it('N 小时前 earlier the same calendar day', () => {
    expect(fmtRelTime(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前')
    expect(fmtRelTime(at(2026, 5, 15, 0, 10), NOW)).toBe('14 小时前')
  })
  it('昨天 and 前天 by calendar day', () => {
    expect(fmtRelTime(at(2026, 5, 14, 23, 50), NOW)).toBe('昨天')
    expect(fmtRelTime(at(2026, 5, 13, 9, 0), NOW)).toBe('前天')
  })
  it('date (M月D日) for older within the same year', () => {
    expect(fmtRelTime(at(2026, 5, 1, 9, 0), NOW)).toBe('6月1日')
  })
  it('full date (YYYY/M/D) across years', () => {
    expect(fmtRelTime(at(2025, 11, 30, 9, 0), NOW)).toBe('2025/12/30')
  })
})

describe('fmtMsgTime', () => {
  const isoAt = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi, 0).toISOString()
  it('today → local HH:MM only (parsed from an ISO instant, not UTC clock)', () => {
    expect(fmtMsgTime(isoAt(2026, 5, 15, 23, 30), NOW)).toBe('23:30')
  })
  it('yesterday / 前天 carry a prefix + time', () => {
    expect(fmtMsgTime(isoAt(2026, 5, 14, 9, 5), NOW)).toBe('昨天 09:05')
    expect(fmtMsgTime(isoAt(2026, 5, 13, 18, 0), NOW)).toBe('前天 18:00')
  })
  it('older days show date + time (same year, then cross-year)', () => {
    expect(fmtMsgTime(isoAt(2026, 5, 1, 8, 0), NOW)).toBe('6月1日 08:00')
    expect(fmtMsgTime(isoAt(2025, 11, 30, 8, 0), NOW)).toBe('2025/12/30 08:00')
  })
  // 旧版 now()=new Date().toISOString().slice(11,19) 存的是 UTC 时钟(无日期)。直接 slice 显示会比本地
  // 时间早/晚一个时区偏移(用户报"时区不对")。这里按 UTC 解释再转本地。
  it('legacy clock-only "HH:MM:SS" is interpreted as UTC and rendered in local time', () => {
    const u = new Date(Date.UTC(1970, 0, 1, 15, 30, 44))
    const p = (n: number) => String(n).padStart(2, '0')
    expect(fmtMsgTime('15:30:44', NOW)).toBe(`${p(u.getHours())}:${p(u.getMinutes())}`)
  })
  it('empty timestamp → empty string', () => {
    expect(fmtMsgTime('', NOW)).toBe('')
  })
})

describe('fmtMsgTimeFull', () => {
  it('parseable ISO → full local YYYY-MM-DD HH:MM:SS (so hovering reveals the day)', () => {
    const d = new Date(2026, 5, 15, 9, 5, 7)
    const p = (n: number) => String(n).padStart(2, '0')
    const exp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(9)}:${p(5)}:${p(7)}`
    expect(fmtMsgTimeFull(d.toISOString())).toBe(exp)
  })
  it('legacy clock-only → local time with a "date unknown" hint', () => {
    const u = new Date(Date.UTC(1970, 0, 1, 15, 30, 44))
    const p = (n: number) => String(n).padStart(2, '0')
    expect(fmtMsgTimeFull('15:30:44')).toBe(`${p(u.getHours())}:${p(u.getMinutes())}:${p(u.getSeconds())} · 旧记录·日期未知`)
  })
  it('empty → empty', () => {
    expect(fmtMsgTimeFull('')).toBe('')
  })
})
