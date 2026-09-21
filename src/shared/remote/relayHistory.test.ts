import { describe, it, expect } from 'vitest'
import { forgetRelayUrl, normalizeRelayUrl, RELAY_URL_HISTORY_MAX, rememberRelayUrl, isRelayUrl, canForgetRelayUrl, relayUrlChoices } from './relayHistory'

describe('中转地址历史', () => {
  it('最近用的排最前', () => {
    expect(rememberRelayUrl(['wss://a'], 'wss://b')).toEqual(['wss://b', 'wss://a'])
  })

  it('再用一次已有的,把它提到最前而不是多存一条', () => {
    expect(rememberRelayUrl(['wss://a', 'wss://b'], 'wss://b')).toEqual(['wss://b', 'wss://a'])
  })

  it('★末尾斜杠算同一个 —— 否则下拉里会出现两个看起来一样的选项', () => {
    expect(rememberRelayUrl(['wss://a.com'], 'wss://a.com/')).toEqual(['wss://a.com'])
    expect(normalizeRelayUrl('  wss://a.com//  ')).toBe('wss://a.com')
  })

  it('★不动大小写 —— 路径是大小写敏感的', () => {
    expect(rememberRelayUrl([], 'wss://A.com/Room')).toEqual(['wss://A.com/Room'])
  })

  it('空的不进历史 —— 那不是地址,是「还没填」', () => {
    expect(rememberRelayUrl(['wss://a'], '')).toEqual(['wss://a'])
    expect(rememberRelayUrl(['wss://a'], '   ')).toEqual(['wss://a'])
  })

  it(`★有上限(${RELAY_URL_HISTORY_MAX})—— 手滑敲错的地址不该永远留在下拉里`, () => {
    let h: string[] = []
    for (let i = 0; i < RELAY_URL_HISTORY_MAX + 5; i++) h = rememberRelayUrl(h, `wss://h${i}`)
    expect(h).toHaveLength(RELAY_URL_HISTORY_MAX)
    expect(h[0]).toBe(`wss://h${RELAY_URL_HISTORY_MAX + 4}`)
  })

  it('不改入参', () => {
    const h = ['wss://a']
    rememberRelayUrl(h, 'wss://b')
    expect(h).toEqual(['wss://a'])
  })

  it('能删掉一条', () => {
    expect(forgetRelayUrl(['wss://a', 'wss://b'], 'wss://a/')).toEqual(['wss://b'])
  })

  it('★★这个模块的签名里没有令牌 —— 历史里永远不可能存进令牌', () => {
    // 地址是公开信息(印在配对二维码里),令牌不是:它能起 agent、替人答权限门、开终端。
    // 把「不存令牌」做成**类型上做不到**,比写一句注释提醒自己可靠。
    const src = rememberRelayUrl.toString() + forgetRelayUrl.toString()
    expect(src).not.toMatch(/token/i)
  })
})

describe('isRelayUrl', () => {
  it('ws:// 和 wss:// 都认,末尾斜杠无所谓', () => {
    expect(isRelayUrl('wss://relay.example.com')).toBe(true)
    expect(isRelayUrl('ws://192.168.1.5:8787/')).toBe(true)
    expect(isRelayUrl('  wss://r.workers.dev  ')).toBe(true)
  })
  it('★明显不是中转地址的拦下:漏协议、贴成 https、只有协议', () => {
    expect(isRelayUrl('relay.example.com')).toBe(false)
    expect(isRelayUrl('https://relay.example.com')).toBe(false)
    expect(isRelayUrl('wss://')).toBe(false)
    expect(isRelayUrl('')).toBe(false)
  })
})

describe('canForgetRelayUrl', () => {
  it('★正在用的那条不许删(末尾斜杠不同也算同一条)', () => {
    expect(canForgetRelayUrl('wss://a.com/', 'wss://a.com')).toBe(false)
  })
  it('别的可以删', () => {
    expect(canForgetRelayUrl('wss://b.com', 'wss://a.com')).toBe(true)
  })
  it('空的不算一条', () => {
    expect(canForgetRelayUrl('', 'wss://a.com')).toBe(false)
  })
})

describe('relayUrlChoices', () => {
  it('当前的排最前,历史去重', () => {
    expect(relayUrlChoices('wss://b.com', ['wss://a.com', 'wss://b.com/', 'wss://c.com'])).toEqual(['wss://b.com', 'wss://a.com', 'wss://c.com'])
  })
  /** ★历史有上限,当前那条可能被挤出去 —— 但它必须还在下拉里,否则看着像「什么都没选」而中转明明连着。 */
  it('★当前那条不在历史里也要摆出来', () => {
    expect(relayUrlChoices('wss://x.com', ['wss://a.com'])).toEqual(['wss://x.com', 'wss://a.com'])
  })
  it('还没用过中转:空列表', () => {
    expect(relayUrlChoices('', [])).toEqual([])
  })
})
