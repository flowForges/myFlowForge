import { describe, it, expect } from 'vitest'
import { isLoopbackHost, parseWsUrl } from './wsUrl'

/**
 * ★这些用例存在的理由是一个真机才会犯的错。
 *
 * React Native 自带的 URL(`react-native/Libraries/Blob/URL.js`)里,`hostname`/`host` 的正则
 * 写死了 `^https?:\/\/`,对 `ws://` 一律返回空串。于是「添加主机」的校验会把**每一个合法地址**
 * 判成「缺主机名」—— 真机上你永远加不进第一台主机。而浏览器的 URL 是完整实现,
 * 所以只在 web 上跑测试**永远照不出来**。
 */
describe('parseWsUrl', () => {
  it('ws:// 带端口 —— 这正是 RN 自带 URL 会返回空 hostname 的那一种', () => {
    expect(parseWsUrl('ws://192.168.1.10:6789')).toEqual({ protocol: 'ws:', hostname: '192.168.1.10', port: '6789' })
  })

  it('wss:// 一样认', () => {
    expect(parseWsUrl('wss://forge.example.com:443')).toEqual({ protocol: 'wss:', hostname: 'forge.example.com', port: '443' })
  })

  it('主机名不带端口', () => {
    expect(parseWsUrl('ws://my-mac.local')).toEqual({ protocol: 'ws:', hostname: 'my-mac.local', port: '' })
  })

  it('末尾一个斜杠不影响', () => {
    expect(parseWsUrl('ws://127.0.0.1:6789/')?.hostname).toBe('127.0.0.1')
  })

  it('IPv6 要带方括号', () => {
    expect(parseWsUrl('ws://[::1]:6789')).toEqual({ protocol: 'ws:', hostname: '[::1]', port: '6789' })
  })

  it('http/https 不收 —— 这是「把网页地址填进来」那一类,要当场拦住', () => {
    expect(parseWsUrl('http://192.168.1.10:6789')).toBeNull()
  })

  it('没有协议头不收(调用方负责先补 ws://)', () => {
    expect(parseWsUrl('192.168.1.10:6789')).toBeNull()
  })

  it('带路径的不收 —— daemon 的地址就是 host:port,多出来的东西是填错了', () => {
    expect(parseWsUrl('ws://1.2.3.4:6789/some/path')).toBeNull()
  })

  it('空的、带空格的都不炸', () => {
    expect(parseWsUrl('')).toBeNull()
    expect(parseWsUrl('   ')).toBeNull()
    expect(parseWsUrl('ws:// 1.2.3.4:6789')).toBeNull()
  })
})

describe('isLoopbackHost', () => {
  it('认得出回环', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true)
    }
  })

  // ★这一条是安全性的:判成回环 = 不要令牌。判错就是开一个免凭据的、能控制整台机器的端口。
  it('★ 127.0.0.1.evil.com 不是回环', () => {
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
  })

  it('局域网地址不是回环', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
    expect(isLoopbackHost('172.20.10.2')).toBe(false)
  })

  it('段超过 255 的不算数', () => {
    expect(isLoopbackHost('127.0.0.999')).toBe(false)
  })
})
