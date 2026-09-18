import { describe, it, expect } from 'vitest'
import { diagnoseHops, hopSummary, type HopInput } from './hopDiagnosis'

const base: HopInput = { viaRelay: true, relaySocketOpen: true, relayStatus: 'peer-online', peerReady: true }

describe('断在哪一跳', () => {
  it('全通', () => {
    const h = diagnoseHops(base)
    expect(h.map(x => x.state)).toEqual(['ok', 'ok'])
    expect(hopSummary(h)).toBe('整条链路通')
  })

  it('★连不上中转 → 断在第一跳', () => {
    const h = diagnoseHops({ ...base, relaySocketOpen: false })
    expect(h[0].state).toBe('bad')
    expect(hopSummary(h)).toContain('这台 → 中转')
  })

  it('★★★第一跳断了,第二跳是 unknown 不是 bad —— 我们对它一无所知', () => {
    // 把未知报成坏掉,会把人送去查一个根本没问题的地方。
    const h = diagnoseHops({ ...base, relaySocketOpen: false })
    expect(h[1].state).toBe('unknown')
    expect(h[1].note, 'unknown 不该编一个原因出来').toBeUndefined()
  })

  it('★★中转说 waiting → 对方没挂上来,断在第二跳(这正是协议白送的答案)', () => {
    const h = diagnoseHops({ ...base, relayStatus: 'waiting', peerReady: false })
    expect(h[0].state).toBe('ok')
    expect(h[1].state).toBe('bad')
    expect(h[1].note).toContain('对方没挂上来')
  })

  it('peer-online 但握不上手 → 对方在线不应答', () => {
    const h = diagnoseHops({ ...base, peerReady: false })
    expect(h[1].state).toBe('bad')
    expect(h[1].note).toContain('没有应答')
  })

  it('直连只有一跳', () => {
    expect(diagnoseHops({ ...base, viaRelay: false })).toHaveLength(1)
    expect(diagnoseHops({ ...base, viaRelay: false, peerReady: false })[0].state).toBe('bad')
  })

  it('★★中转→对方的 RT 是**推算**的(端到端 − 到中转)', () => {
    const h = diagnoseHops({ ...base, relayRttMs: 30, peerRttMs: 95 })
    expect(h[0].rttMs).toBe(30)
    expect(h[1].rttMs).toBe(65)
  })

  it('★★★算出非正数就不显示 —— 抖动会让差值变负,宁可不给也不给一个负时延', () => {
    expect(diagnoseHops({ ...base, relayRttMs: 90, peerRttMs: 80 })[1].rttMs).toBeUndefined()
    expect(diagnoseHops({ ...base, relayRttMs: 80, peerRttMs: 80 })[1].rttMs).toBeUndefined()
  })

  it('★没测到就是 undefined,绝不填 0 冒充「很快」', () => {
    const h = diagnoseHops(base)
    expect(h[0].rttMs).toBeUndefined()
    expect(h[1].rttMs).toBeUndefined()
  })

  it('★断掉那一跳不报 RT —— 一个「断了但 30ms」的格子只会让人更糊涂', () => {
    expect(diagnoseHops({ ...base, relaySocketOpen: false, relayRttMs: 30 })[0].rttMs).toBeUndefined()
  })
})

/**
 * ★★守卫:短的归短的,长的归长的。
 *  用户 2026-09-18 看到的那一屏是「又乱又差,为什么这么多文字」—— 根因是 `note` 里塞了
 *  一整句带破折号的解释,而它画在链路那一行里,把布局撑爆了。
 *  这条断言不测样子(那要真 Chrome),只钉死:**note 必须短到能并排画**,长句一律进 hint。
 *  没有它,这句话会一次加几个字地长回去,而每次单独看都「只多了半句」。
 */
describe('坏消息的长度', () => {
  const cases: Parameters<typeof diagnoseHops>[0][] = [
    { viaRelay: false, relaySocketOpen: false, peerReady: false },
    { viaRelay: true, relaySocketOpen: false, peerReady: false },
    { viaRelay: true, relaySocketOpen: true, relayStatus: 'waiting', peerReady: false },
    { viaRelay: true, relaySocketOpen: true, relayStatus: 'error', peerReady: false },
    { viaRelay: true, relaySocketOpen: true, relayStatus: 'peer-online', peerReady: false },
  ]
  it('★note 画在链路行里,必须 ≤ 8 个字', () => {
    for (const c of cases) {
      for (const h of diagnoseHops(c)) {
        if (h.note) expect(h.note.length, `太长了,挪进 hint:「${h.note}」`).toBeLessThanOrEqual(8)
        expect(h.note ?? '', 'note 里不该出现破折号 —— 那说明你把两句话塞进了一句').not.toContain('——')
      }
    }
  })
  it('★推算出来的时延必须带 derived 标记', () => {
    const h = diagnoseHops({ viaRelay: true, relaySocketOpen: true, relayStatus: 'peer-online', peerReady: true, relayRttMs: 20, peerRttMs: 55 })
    expect(h[1]!.rttMs).toBe(35)
    expect(h[1]!.derived, '不标出来,界面就会把推算值画得和实测一样').toBe(true)
  })
})
