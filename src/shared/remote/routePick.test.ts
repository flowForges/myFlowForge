import { describe, it, expect } from 'vitest'
import {
  routesFor, firstRoute, shouldProbeLan, afterLanDrop, freshMemory,
  LAN_PROBE_INTERVAL_MS, LAN_FLAP_WINDOW_MS, LAN_COOLDOWN_MS,
} from './routePick'

// 2026-10-07 用户要的:共享主机同时开了局域网和中转时,在家自动走局域网、出门自动走中转,
// 回到家自动迁回局域网,全程不用自己切。配对码里本来就两条都带(a= 局域网、r= 中转),
// 原来两端都是 `relayUrl || url` —— 有中转就无条件走中转,局域网地址躺在记录里没人用。
const both = { lanUsable: true, relay: 'wss://relay.example', pubKey: 'K' }

describe('routesFor —— 这台主机有哪几条路,按先后', () => {
  it('★两条都有:先局域网,后中转', () => {
    expect(routesFor(both)).toEqual(['lan', 'relay'])
  })
  it('只有局域网(老配对码 / 没开中转)', () => {
    expect(routesFor({ lanUsable: true, relay: '', pubKey: 'K' })).toEqual(['lan'])
    expect(routesFor({ lanUsable: true })).toEqual(['lan'])
  })
  it('★分享时没开局域网(码里填的是回环地址):只走中转,连试都不试', () => {
    expect(routesFor({ ...both, lanUsable: false })).toEqual(['relay'])
  })
  it('有中转却没有公钥是配置错误:照旧只给中转,让客户端报出那句「请重新生成配对码」', () => {
    expect(routesFor({ lanUsable: true, relay: 'wss://r', pubKey: '' })).toEqual(['relay'])
  })
})

describe('firstRoute —— 建连时先拨哪条', () => {
  it('平时:局域网', () => {
    expect(firstRoute(['lan', 'relay'], freshMemory(), 1000)).toBe('lan')
  })
  it('★局域网刚闪断过、还在冷却期:直接走中转,不白等那 1.5 秒', () => {
    const m = { ...freshMemory(), cooldownUntil: 5000 }
    expect(firstRoute(['lan', 'relay'], m, 4000)).toBe('relay')
    expect(firstRoute(['lan', 'relay'], m, 5000)).toBe('lan')
  })
  it('只有一条路时冷却期也只能走它', () => {
    expect(firstRoute(['lan'], { ...freshMemory(), cooldownUntil: 9e9 }, 0)).toBe('lan')
  })
})

describe('shouldProbeLan —— 走着中转的时候,要不要去看一眼局域网通没通', () => {
  const base = { route: 'relay' as const, routes: ['lan', 'relay'] as const, foreground: true }
  it('★前台 + 走中转 + 间隔到了:探', () => {
    expect(shouldProbeLan(freshMemory(), { ...base, now: LAN_PROBE_INTERVAL_MS })).toBe(true)
  })
  it('★已经在局域网上:完全不探(零开销)', () => {
    expect(shouldProbeLan(freshMemory(), { ...base, route: 'lan', now: 9e9 })).toBe(false)
  })
  it('★在后台:不探(省电;iOS 后台连接本来也会被收掉)', () => {
    expect(shouldProbeLan(freshMemory(), { ...base, foreground: false, now: 9e9 })).toBe(false)
  })
  it('间隔没到:不探', () => {
    const m = { ...freshMemory(), lastProbeAt: 1000 }
    expect(shouldProbeLan(m, { ...base, now: 1000 + LAN_PROBE_INTERVAL_MS - 1 })).toBe(false)
  })
  it('★刚回到前台(force):不看间隔立刻探 —— 出门回来那一刻正是最可能迁回去的时候', () => {
    const m = { ...freshMemory(), lastProbeAt: 1000 }
    expect(shouldProbeLan(m, { ...base, now: 1001, force: true })).toBe(true)
  })
  it('★冷却期里连 force 也不探 —— 防在信号边缘来回横跳', () => {
    const m = { ...freshMemory(), cooldownUntil: 5000 }
    expect(shouldProbeLan(m, { ...base, now: 4000, force: true })).toBe(false)
  })
  it('这台主机压根没有局域网线路:永不探', () => {
    expect(shouldProbeLan(freshMemory(), { ...base, routes: ['relay'], now: 9e9, force: true })).toBe(false)
  })
})

describe('afterLanDrop —— 局域网断了之后怎么记账', () => {
  it('★迁过去没多久就断(信号边缘):冷却 5 分钟', () => {
    const m = { ...freshMemory(), lanSince: 10_000 }
    const next = afterLanDrop(m, 10_000 + LAN_FLAP_WINDOW_MS - 1)
    expect(next.cooldownUntil).toBe(10_000 + LAN_FLAP_WINDOW_MS - 1 + LAN_COOLDOWN_MS)
    expect(next.lanSince).toBeNull()
  })
  it('稳定用了很久才断(比如出门了):不冷却,下次照常先试局域网', () => {
    const m = { ...freshMemory(), lanSince: 10_000 }
    const next = afterLanDrop(m, 10_000 + LAN_FLAP_WINDOW_MS)
    expect(next.cooldownUntil).toBe(0)
    expect(next.lanSince).toBeNull()
  })
  it('根本没在局域网上(lanSince 为空):什么都不变', () => {
    expect(afterLanDrop(freshMemory(), 123)).toEqual(freshMemory())
  })
})
