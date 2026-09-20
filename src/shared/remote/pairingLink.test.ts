import { describe, it, expect } from 'vitest'
import { buildPairingLink, parsePairingLink } from './pairingLink'

describe('配对链接', () => {
  it('build → parse 原样回来', () => {
    const p = { address: '192.168.110.133:6789', token: 'abc-_123', label: 'zghua 的 Mac' }
    const r = parsePairingLink(buildPairingLink(p))
    expect(r).toEqual({ ok: true, value: p })
  })

  it('地址里的冒号要被编码,否则解析器会把端口当成别的东西', () => {
    const link = buildPairingLink({ address: '10.0.0.2:6789', token: '', label: '' })
    expect(link).toContain('a=10.0.0.2%3A6789')
    // 回环那种没令牌的情况,不该往链接里塞一个空的 t=
    expect(link).not.toContain('t=')
    expect(parsePairingLink(link)).toEqual({ ok: true, value: { address: '10.0.0.2:6789', token: '', label: '' } })
  })

  it('中文机器名截到 24 个字并且能原样解回来', () => {
    const long = '书'.repeat(40)
    const r = parsePairingLink(buildPairingLink({ address: 'a:1', token: 't', label: long }))
    expect(r.ok && r.value.label).toBe('书'.repeat(24))
  })

  it('相机回吐的各种形状都收', () => {
    for (const s of [
      'myflowforge://add-host?v=1&a=1.2.3.4%3A6789&t=T',
      'MyFlowForge://Add-Host?v=1&a=1.2.3.4%3A6789&t=T',   // 大小写
      'myflowforge:/add-host?v=1&a=1.2.3.4%3A6789&t=T',    // 单斜杠
      'myflowforge://add-host/?v=1&a=1.2.3.4%3A6789&t=T',  // 尾斜杠
      'myflowforge://add-host?a=1.2.3.4%3A6789&t=T',       // 没有 v=
    ]) {
      const r = parsePairingLink(s)
      expect(r.ok, s).toBe(true)
      expect(r.ok && r.value).toEqual({ address: '1.2.3.4:6789', token: 'T', label: '' })
    }
  })

  it('别人家的码要说人话,不能只说「地址看不懂」', () => {
    expect(parsePairingLink('https://example.com')).toEqual({ ok: false, error: expect.stringContaining('https') })
    expect(parsePairingLink('WIFI:S:home;T:WPA;P:pw;;')).toEqual({ ok: false, error: expect.stringContaining('wifi') })
    expect(parsePairingLink('myflowforge://gate?id=1')).toEqual({ ok: false, error: expect.stringContaining('添加主机') })
    expect(parsePairingLink('')).toEqual({ ok: false, error: '没扫到内容' })
  })

  it('缺地址的码不能过 —— 过了的话手机会存下一台连不上的主机', () => {
    expect(parsePairingLink('myflowforge://add-host?v=1&t=T').ok).toBe(false)
  })

  it('未来版本给的是「升级手机 app」而不是一句看不懂', () => {
    const r = parsePairingLink('myflowforge://add-host?v=2&a=1.2.3.4%3A6789')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('升级') })
  })
})

// ── 第三期:`k`(身份公钥)和 `r`(中转地址)─────────────────────────────────
describe('配对链接 v2:公钥 + 中转', () => {
  const K = 'A'.repeat(43) + '='   // 44 字符的合法 base64,长度就是 Ed25519 公钥那一档
  const base = { address: '192.168.1.20:6789', token: 'tok', label: '我的 Mac' }

  it('公钥和中转地址能原样往返', () => {
    const link = buildPairingLink({ ...base, pubKey: K, relay: 'wss://relay.example.com' })
    const r = parsePairingLink(link)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.pubKey).toBe(K)
      expect(r.value.relay).toBe('wss://relay.example.com')
      // 原来那三样一个都不能丢
      expect(r.value.address).toBe(base.address)
      expect(r.value.token).toBe(base.token)
      expect(r.value.label).toBe(base.label)
    }
  })

  it('★★老码(没有 k / r)必须继续能扫 —— 否则一次升级会让所有配过对的手机同时失效', () => {
    const r = parsePairingLink('myflowforge://add-host?v=1&a=192.168.1.20%3A6789&t=tok&n=Mac')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.pubKey).toBeUndefined()
      expect(r.value.relay).toBeUndefined()
      expect(r.value.address).toBe('192.168.1.20:6789')
    }
  })

  it('★版本号仍然是 1 —— k/r 是可选新增字段,升版本号会让老手机直接拒扫', () => {
    expect(buildPairingLink({ ...base, pubKey: K, relay: 'wss://x.y' })).toContain('v=1')
  })

  it('只有 k 没有 r = 直连但加密,合法', () => {
    const r = parsePairingLink(buildPairingLink({ ...base, pubKey: K }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.pubKey).toBe(K)
      expect(r.value.relay).toBeUndefined()
    }
  })

  it('★★有 r 没有 k 一律拒 —— 那等于把令牌和全部内容交给一台不验证身份的第三方服务器', () => {
    const r = parsePairingLink('myflowforge://add-host?v=1&a=x%3A1&r=wss%3A%2F%2Frelay.example.com')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('身份公钥')
  })

  it('★公钥长度/字符不对就整条拒,不"尽量解出来"', () => {
    for (const bad of ['AAAA', 'A'.repeat(43), 'A'.repeat(45), 'A'.repeat(43) + '!', '中'.repeat(44)]) {
      const link = `myflowforge://add-host?v=1&a=x%3A1&k=${encodeURIComponent(bad)}`
      const r = parsePairingLink(link)
      expect(r.ok, bad).toBe(false)
    }
  })

  it('中转地址必须是 ws:// 或 wss://', () => {
    for (const bad of ['https://relay.example.com', 'relay.example.com', 'javascript:alert(1)']) {
      const link = `myflowforge://add-host?v=1&a=x%3A1&k=${encodeURIComponent(K)}&r=${encodeURIComponent(bad)}`
      const r = parsePairingLink(link)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error).toContain('ws://')
    }
  })

  it('★中转地址有长度上限 —— 二维码容量有限,几百字符的"地址"本来也不是地址', () => {
    const long = 'wss://' + 'a'.repeat(200)
    const link = `myflowforge://add-host?v=1&a=x%3A1&k=${encodeURIComponent(K)}&r=${encodeURIComponent(long)}`
    expect(parsePairingLink(link).ok).toBe(false)
  })

  it('带 + 和 / 的公钥(base64 里合法)不能被 query 的 + 转空格弄坏', () => {
    const k = 'ab+/' + 'A'.repeat(39) + '='
    const r = parsePairingLink(buildPairingLink({ ...base, pubKey: k }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.pubKey).toBe(k)
  })
})
