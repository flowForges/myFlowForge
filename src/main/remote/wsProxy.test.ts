import { describe, it, expect } from 'vitest'
import { pickProxy, proxyUsable } from './wsProxy'

describe('pickProxy', () => {
  it('设置里填了就用设置', () => {
    expect(pickProxy('http://127.0.0.1:7897', {})).toEqual({ use: true, url: 'http://127.0.0.1:7897', from: 'setting' })
  })

  it('★设置优先于环境变量 —— 从 Dock 点开的 Electron 根本拿不到 shell 的 http_proxy', () => {
    const r = pickProxy('http://from-setting:1', { https_proxy: 'http://from-env:2' })
    expect(r).toEqual({ use: true, url: 'http://from-setting:1', from: 'setting' })
  })

  it('★设置为空时退到环境变量 —— 无头 daemon 上更习惯 export https_proxy', () => {
    expect(pickProxy('', { https_proxy: 'http://p:1' })).toEqual({ use: true, url: 'http://p:1', from: 'env' })
    expect(pickProxy(undefined, { HTTPS_PROXY: 'http://p:2' }).use).toBe(true)
    expect(pickProxy('   ', { http_proxy: 'http://p:3' })).toEqual({ use: true, url: 'http://p:3', from: 'env' })
    expect(pickProxy('', { HTTP_PROXY: 'http://p:4' }).use).toBe(true)
  })

  it('https_proxy 比 http_proxy 优先(中转地址是 wss)', () => {
    const r = pickProxy('', { https_proxy: 'http://s:1', http_proxy: 'http://p:2' })
    expect(r.use).toBe(true)
    expect(r.use === true && r.url).toBe('http://s:1')
  })

  it('两处都没有就是不走代理,而且带一句能记进日志的原因', () => {
    const r = pickProxy('', {})
    expect(r.use).toBe(false)
    expect(r.use === false && r.why).toBeTruthy()
  })
})

describe('proxyUsable', () => {
  it('wss + http 代理 → 可用', () => {
    expect(proxyUsable('wss://r.example.dev/', 'http://127.0.0.1:7897')).toEqual({ ok: true })
    expect(proxyUsable('WSS://R.EXAMPLE.DEV/', 'HTTPS://127.0.0.1:7897')).toEqual({ ok: true })
  })

  it('★ws:// 不套代理,但要说出来 —— 静默直连正是「永远转圈」的来源', () => {
    const r = proxyUsable('ws://10.0.0.2:8787', 'http://127.0.0.1:7897')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.why).toContain('wss')
  })

  it('★socks 代理不套,也要说出来', () => {
    const r = proxyUsable('wss://r.example.dev/', 'socks5://127.0.0.1:1080')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.why).toContain('socks')
  })

  it('两头带空白也认得出来', () => {
    expect(proxyUsable('  wss://r.example.dev/  ', '  http://p:1  ')).toEqual({ ok: true })
  })
})
