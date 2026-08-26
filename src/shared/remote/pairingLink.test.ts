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
