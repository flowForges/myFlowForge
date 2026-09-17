/**
 * 「连不上」到底断在哪一跳 —— A(这台)→ 中转 → B(对面那台)。
 *
 * ★★★用户 2026-09-17 提的:「如果通过中转 A 连接 中转服务器 连接 B,我们应该有个地方显示,
 *  如果没有连接成功,是 A 到中转服务器的问题 还是 中转服务器到 B 的问题」。
 *  这件事**不需要猜** —— 中转协议本来就把答案发过来了(`RelayStatus`):
 *    · WebSocket 都没开起来        → 断在 **A↔中转**
 *    · 开起来了但收到 `waiting`     → 中转在,**对面没挂上来**(断在 中转↔B)
 *    · `peer-online` 但握不上手     → B 挂在中转上,但**不应答**
 *  之前这些信息全被压成了一句「连不上」,于是人只能挨个猜。
 *
 * ★零 import(类型除外),纯函数,能在 node 下直接测。
 */

/** 一跳的状态。`unknown` = 还没轮到它 —— 前一跳都没通,后一跳无从谈起,**不能报成「坏了」**。 */
export type HopState = 'ok' | 'bad' | 'unknown'

export type HopView = {
  /** 这一跳的名字,画在界面上。 */
  label: string
  state: HopState
  /** 往返时延(毫秒)。没测到就是 undefined —— **绝不填 0 冒充「很快」**。 */
  rttMs?: number
  /** 这一跳出了什么事;`ok` 时为空。 */
  note?: string
}

export type HopInput = {
  /** 这条主机是不是走中转。不走中转就只有一跳(直连)。 */
  viaRelay: boolean
  /** 到中转的 WebSocket 开起来没有。 */
  relaySocketOpen: boolean
  /** 中转最近一次报上来的状态(没收到过就是 undefined)。 */
  relayStatus?: 'waiting' | 'peer-online' | 'peer-offline' | 'error'
  /** 和对面的端到端握手完成了没有。 */
  peerReady: boolean
  /** A→中转 的往返(直接测得)。 */
  relayRttMs?: number
  /** A→B 端到端往返(直接测得)。 */
  peerRttMs?: number
}

/**
 * 三跳(或直连时两跳)的诊断。
 *
 * ★★中转→B 那一段**测不到**:我们只能从 A 这头发包。所以它是 `端到端 − A到中转` **推算**出来的,
 *  界面上必须标明是推算值 —— 把推算的数字画得和实测一样,是在编造精度。
 * ★★前一跳不通时,后面的跳一律 `unknown`,不是 `bad`:第一跳断了的时候,我们对第二跳
 *  **什么都不知道**。把未知报成坏掉,会把人送去查一个根本没问题的地方。
 */
export function diagnoseHops(i: HopInput): HopView[] {
  if (!i.viaRelay) {
    return [{
      label: '直连对方',
      state: i.peerReady ? 'ok' : 'bad',
      rttMs: i.peerReady ? i.peerRttMs : undefined,
      note: i.peerReady ? undefined : '连不上对方 —— 检查地址、端口,以及两台是不是在同一个网里',
    }]
  }

  const a2r: HopView = i.relaySocketOpen
    ? { label: '这台 → 中转', state: 'ok', rttMs: i.relayRttMs }
    : { label: '这台 → 中转', state: 'bad', note: '连不上中转 —— 检查中转地址,以及这台机器的网络' }

  if (!i.relaySocketOpen) {
    // ★后面两跳一律 unknown。第一跳都没通,我们对中转和对方**一无所知**。
    return [a2r, { label: '中转 → 对方', state: 'unknown' }]
  }

  if (i.relayStatus === 'waiting' || i.relayStatus === 'peer-offline') {
    return [a2r, {
      label: '中转 → 对方', state: 'bad',
      note: '中转在,但对方没挂上来 —— 那台电脑上的 myFlowForge 没开,或者它那边的中转地址不一样',
    }]
  }
  if (i.relayStatus === 'error') {
    return [a2r, { label: '中转 → 对方', state: 'bad', note: '中转拒绝了这次连接' }]
  }
  if (!i.peerReady) {
    return [a2r, {
      label: '中转 → 对方', state: i.relayStatus === 'peer-online' ? 'bad' : 'unknown',
      note: i.relayStatus === 'peer-online' ? '对方挂在中转上,但没有应答 —— 它可能正忙或刚断' : undefined,
    }]
  }
  // ★推算值:中转→B ≈ 端到端 − A→中转。两个都测到才给,而且**只在算得出正数时**给 ——
  //  抖动会让差值变成负数,那时候宁可不显示,也不显示一个负的时延。
  const derived = i.peerRttMs != null && i.relayRttMs != null ? i.peerRttMs - i.relayRttMs : undefined
  return [a2r, {
    label: '中转 → 对方', state: 'ok',
    rttMs: derived != null && derived > 0 ? derived : undefined,
  }]
}

/** 一句话结论,给不想看三行的人。 */
export function hopSummary(hops: readonly HopView[]): string {
  const bad = hops.find((h) => h.state === 'bad')
  if (bad) return `断在「${bad.label}」`
  if (hops.some((h) => h.state === 'unknown')) return '还在确认'
  return '整条链路通'
}
