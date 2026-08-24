import { describe, it, expect } from 'vitest'
import { isIsoTimestamp, sepLabel, sepsFor } from './timeSep'

// 2026-08-25 23:04 本地时间。用本地构造(不是 UTC 串),因为要验的正是「按本地日历分今天/昨天」。
const NOW = new Date(2026, 7, 25, 23, 40, 0).getTime()
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime()

describe('isIsoTimestamp —— 什么串才准交给 Date.parse', () => {
  // ★这条谓词单独存在、单独测,是因为「HH:MM:SS 别被当成日期」在 Node 上**验不出来**:
  //  V8 的 Date.parse('23:04:11') 返回 NaN,把守卫拆掉测试照样全绿。Hermes 不保证一样。
  it('ISO 才算', () => {
    expect(isIsoTimestamp('2026-06-30T11:05:58.897Z')).toBe(true)
    expect(isIsoTimestamp('2026-06-30T11:05:58+08:00')).toBe(true)
  })
  it('★只有时刻的串一律不算 —— 它里面根本没有日期', () => {
    expect(isIsoTimestamp('23:04:11')).toBe(false)
    expect(isIsoTimestamp('9:05')).toBe(false)
  })
  it('只有日期没有 T 也不算(不知道是几点,补 00:00 就是编)', () => {
    expect(isIsoTimestamp('2026-06-30')).toBe(false)
  })
  it('空串 / 垃圾不算', () => {
    expect(isIsoTimestamp('')).toBe(false)
    expect(isIsoTimestamp('刚刚')).toBe(false)
  })
})

describe('sepLabel', () => {
  it('今天 → 今天 HH:MM', () => {
    expect(sepLabel({ startedAt: at(2026, 7, 25, 23, 4) }, NOW)).toBe('今天 23:04')
  })

  it('昨天 → 昨天 HH:MM', () => {
    expect(sepLabel({ startedAt: at(2026, 7, 24, 23, 41) }, NOW)).toBe('昨天 23:41')
  })

  it('更早 → M月D日(原型的 `8月19日`,不带时刻)', () => {
    expect(sepLabel({ startedAt: at(2026, 7, 19, 9, 5) }, NOW)).toBe('8月19日')
  })

  it('★跨天靠的是本地零点,不是「减 24 小时」', () => {
    // 今天 00:10 的消息,离 now 只有不到一天,但那也是今天。
    expect(sepLabel({ startedAt: at(2026, 7, 25, 0, 10) }, NOW)).toBe('今天 00:10')
    // 昨天 23:50 的消息,离 now 也不到一天,但它是昨天。
    expect(sepLabel({ startedAt: at(2026, 7, 24, 23, 50) }, NOW)).toBe('昨天 23:50')
  })

  it('老消息的 ISO ts 也能判日期', () => {
    const iso = new Date(at(2026, 7, 25, 8, 7)).toISOString()
    expect(sepLabel({ ts: iso }, NOW)).toBe('今天 08:07')
  })

  it('★只有 `HH:MM:SS` 的时候绝不补「今天」', () => {
    // 现在的 chatService.now() 写的就是 `15:01:38` —— 里面**没有日期**。
    // 补一个「今天」上去就是在编:昨天的会话打开来会显示成今天的。
    expect(sepLabel({ ts: '15:01:38' }, NOW)).toBe('15:01')
    expect(sepLabel({ ts: '9:05' }, NOW)).toBe('09:05')
  })

  it('★`23:04:11` 不许被 Date.parse 当成日期', () => {
    // 一旦交给 Date 解析,某些引擎会解析成「今年某天的 23:04」,于是「今天」是编出来的。
    expect(sepLabel({ ts: '23:04:11' }, NOW)).not.toContain('今天')
  })

  it('拿不到时间就不画', () => {
    expect(sepLabel({}, NOW)).toBeNull()
    expect(sepLabel({ ts: '' }, NOW)).toBeNull()
    // 流式中的消息 ts 是 ''(chatService 用它标记「还没落档」)
    expect(sepLabel({ ts: '', startedAt: 0 }, NOW)).toBeNull()
    expect(sepLabel({ ts: '不是时间' }, NOW)).toBeNull()
  })

  it('startedAt 优先于 ts', () => {
    expect(sepLabel({ ts: '01:02:03', startedAt: at(2026, 7, 25, 23, 4) }, NOW)).toBe('今天 23:04')
  })
})

describe('sepsFor —— 只在轮次之间来一根', () => {
  const u = (id: string, t: number) => ({ id, who: 'user' as const, startedAt: t })
  const a = (id: string, t: number) => ({ id, who: 'ai' as const, startedAt: t })

  it('★代理那条永远不带分隔线 —— 否则一问一答就是两根', () => {
    const m = sepsFor([u('u1', at(2026, 7, 25, 23, 4)), a('a1', at(2026, 7, 25, 23, 5))], NOW)
    expect([...m.keys()]).toEqual(['u1'])
  })

  it('★同一分钟内连发不重复画', () => {
    const m = sepsFor(
      [u('u1', at(2026, 7, 25, 23, 4)), a('a1', at(2026, 7, 25, 23, 4)), u('u2', at(2026, 7, 25, 23, 4))],
      NOW,
    )
    expect([...m.keys()]).toEqual(['u1'])
  })

  it('隔了几分钟的下一轮有自己的时间', () => {
    const m = sepsFor([u('u1', at(2026, 7, 25, 23, 4)), u('u2', at(2026, 7, 25, 23, 9))], NOW)
    expect([...m.entries()]).toEqual([
      ['u1', '今天 23:04'],
      ['u2', '今天 23:09'],
    ])
  })

  it('★用户那条只有 HH:MM:SS 时,借同一轮回复的日期', () => {
    // 真数据就是这样:chatService.now() 给用户消息写的是 `15:01:17`,没有日期;
    // 代理那条才有 epoch 的 startedAt。不借的话,昨天的会话打开来第一根线上只有个光秃秃的 15:01。
    const m = sepsFor(
      [
        { id: 'u1', who: 'user' as const, ts: '15:01:17' },
        { id: 'a1', who: 'ai' as const, startedAt: at(2026, 7, 24, 15, 1) },
      ],
      NOW,
    )
    expect(m.get('u1')).toBe('昨天 15:01')
  })

  it('★跨午夜:23:59 发的,回复是第二天 00:00 开始的 —— 不能标成回复那天', () => {
    const m = sepsFor(
      [
        { id: 'u1', who: 'user' as const, ts: '23:59:50' },
        { id: 'a1', who: 'ai' as const, startedAt: at(2026, 7, 25, 0, 0) },
      ],
      NOW,
    )
    // 用户那条发生在 8月24日 23:59,不是 8月25日
    expect(m.get('u1')).toBe('昨天 23:59')
  })

  it('★不借下一轮的日期 —— 中间隔着另一条用户发言就停', () => {
    const m = sepsFor(
      [
        { id: 'u1', who: 'user' as const, ts: '15:01:17' },
        { id: 'u2', who: 'user' as const, ts: '16:02:00' },
        { id: 'a2', who: 'ai' as const, startedAt: at(2026, 7, 25, 16, 2) },
      ],
      NOW,
    )
    // u1 借不到,退成光秃秃的时刻;u2 借得到
    expect(m.get('u1')).toBe('15:01')
    expect(m.get('u2')).toBe('今天 16:02')
  })

  it('拿不到时间的那条被跳过,不影响后面的', () => {
    const m = sepsFor([{ id: 'u0', who: 'user' as const }, u('u1', at(2026, 7, 25, 23, 4))], NOW)
    expect([...m.keys()]).toEqual(['u1'])
  })
})
