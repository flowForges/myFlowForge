import { describe, expect, it } from 'vitest'
import { asRelayStatus, hostClose, hostData, joinFrame, parseHostEnvelope, roomFor } from './relayWire'
// ★★故意 import 中转那一侧的实现:这是「契约的两半」唯一的自动化对账。
//  生产代码**不**这么 import(中转要能被单独 clone 出去部署),但测试可以 ——
//  测试不参与打包,而漂移的代价是「扫了码连不上,两边各自都说自己没错」。
import { parseHostEnvelope as relayParse, parseJoin, isValidRoom } from '../../../relay/src/core'

describe('relayWire · 和中转那一侧对账', () => {
  it('★app 造出来的 join 帧,中转必须解得开', () => {
    for (const role of ['host', 'client'] as const) {
      const room = 'kZ8vQ2mN4pR7sT1uW3xY5zA6bC8dE0fG'
      const raw = JSON.stringify(joinFrame(role, room))
      expect(parseJoin(raw)).toEqual({ t: 'join', role, room })
    }
  })

  it('★app 造出来的房间号,中转必须认', () => {
    // 32 字节的 Ed25519 公钥 → base64 是 44 个字符,落在中转的 20..128 区间里
    const pub = new Uint8Array(32).fill(0xab)
    const room = roomFor(pub)
    expect(room).toHaveLength(44)
    expect(isValidRoom(room)).toBe(true)
  })

  it('★★任意公钥的房间号都必须过中转那道门 —— 有一把不过就是「有的机器扫码连不上」', () => {
    for (let i = 0; i < 256; i++) {
      const pub = new Uint8Array(32)
      for (let j = 0; j < 32; j++) pub[j] = (i * 7 + j * 31) & 0xff
      expect(isValidRoom(roomFor(pub)), `第 ${i} 把`).toBe(true)
    }
  })

  it('★两边的信封解析器对同一串输入必须给出同一个答案', () => {
    const cases = [
      hostData('1', 'hello'),
      hostData('12', '{"t":"enc","c":"AAAA"}'),
      hostClose('3'),
      JSON.stringify({ t: 'open', cid: '4' }),
      '{',
      'null',
      '"a"',
      '[]',
      JSON.stringify({ t: 'data' }),
      JSON.stringify({ t: 'data', cid: '1' }),
      JSON.stringify({ t: 'data', cid: '', d: 'x' }),
      JSON.stringify({ t: 'data', cid: '../x', d: 'x' }),
      JSON.stringify({ t: 'data', cid: '1'.repeat(17), d: 'x' }),
      JSON.stringify({ t: 'data', cid: 1, d: 'x' }),
      JSON.stringify({ t: 'nope', cid: '1' }),
    ]
    for (const raw of cases) {
      const mine = parseHostEnvelope(raw)
      const theirs = relayParse(raw)
      // ★中转那一侧不需要认 `open`(它是中转**发出**的,不是收的),所以只对账它认的那几种。
      if (mine?.t === 'open') { expect(theirs).toBeNull(); continue }
      expect(theirs, raw).toEqual(mine)
    }
  })
})

describe('relayWire · 自己这一侧', () => {
  it('open / close / data 都解得出来', () => {
    expect(parseHostEnvelope(JSON.stringify({ t: 'open', cid: '7' }))).toEqual({ t: 'open', cid: '7' })
    expect(parseHostEnvelope(hostClose('7'))).toEqual({ t: 'close', cid: '7' })
    expect(parseHostEnvelope(hostData('7', 'x'))).toEqual({ t: 'data', cid: '7', d: 'x' })
  })

  it('★`d` 原样,不做任何规范化 —— 里面可能是密文', () => {
    const nasty = ' \r\n\t{"t":"enc","c":"AAAA//++=="} 中🛡 '
    const r = parseHostEnvelope(hostData('1', nasty))
    expect(r).toEqual({ t: 'data', cid: '1', d: nasty })
  })

  it('★空 d 要保住 —— 不能当成「没东西」吞掉', () => {
    expect(parseHostEnvelope(hostData('1', ''))).toEqual({ t: 'data', cid: '1', d: '' })
  })

  it('中转状态帧认得出来,别的一律不是', () => {
    expect(asRelayStatus(JSON.stringify({ t: 'relay', status: 'waiting' }))).toEqual({ t: 'relay', status: 'waiting', error: undefined })
    expect(asRelayStatus(JSON.stringify({ t: 'relay', status: 'error', error: '房间满了' }))?.error).toBe('房间满了')
    // 既有协议的帧走到这里必须**不是**状态帧,否则两层会混起来
    expect(asRelayStatus(JSON.stringify({ t: 'hello', protocol: 1 }))).toBeNull()
    expect(asRelayStatus('{')).toBeNull()
    expect(asRelayStatus('密文不是 JSON')).toBeNull()
  })
})
