import { describe, it, expect } from 'vitest'
import { describeHostState, hostBannerDetail, hostBannerTitle, hostSubtitle } from './hostStatusText'

describe('describeHostState', () => {
  it('★没连上的三种状态语气必须是 off/idle —— 拿缓存假装在线是本轮最贵的一类 bug', () => {
    expect(describeHostState(null).tone).toBe('idle')
    expect(describeHostState({ status: 'closed' }).tone).toBe('idle')
    expect(describeHostState({ status: 'failed', error: '令牌不对' }).tone).toBe('off')
    expect(describeHostState({ status: 'retrying', attempt: 2, error: '连不上', nextInMs: 3000 }).tone).toBe('off')
    // 只有 ready 才是 ok。connecting 是「还不知道」,不是「行了」。
    expect(describeHostState({ status: 'connecting', attempt: 1 }).tone).toBe('wait')
    expect(describeHostState({ status: 'ready', version: '1.2.0', methods: new Set() }).tone).toBe('ok')
  })

  it('★断线那句里必须带着原因 —— 那一行是断线时屏幕上唯一说明「为什么」的地方', () => {
    expect(describeHostState({ status: 'failed', error: '令牌不对' }).text).toContain('令牌不对')
    const r = describeHostState({ status: 'retrying', attempt: 2, error: '连不上', nextInMs: 3400 })
    expect(r.text).toContain('连不上')
    // 毫秒要四舍五入成秒:3400ms 是「3 秒后」,不是「3.4 秒后」也不是一串毫秒数。
    expect(r.text).toContain('3 秒后')
  })

  it('第一次连接不报次数,重试才报 —— 冷启动那一下报「第 1 次」像是已经失败过一回了', () => {
    expect(describeHostState({ status: 'connecting', attempt: 1 }).text).toBe('连接中…')
    expect(describeHostState({ status: 'connecting', attempt: 3 }).text).toContain('第 3 次')
  })

  it('连上了报对面的版本 —— 版本对不上是「功能突然置灰」最常见的原因', () => {
    expect(describeHostState({ status: 'ready', version: '1.2.0', methods: new Set() }).text).toContain('1.2.0')
  })
})

describe('hostSubtitle', () => {
  const ready = { status: 'ready', version: '1.2.0', methods: new Set<string>() } as const

  it('★不是当前这台就只报地址 —— 给它安一句「未连接」会让人以为它刚断线', () => {
    expect(hostSubtitle('ws://192.168.1.10:6789', null, false)).toBe('192.168.1.10:6789')
    // 就算手上有别的机器的状态,非当前那几行也一个字都不该跟着变。
    expect(hostSubtitle('wss://box:6789', ready, false)).toBe('box:6789')
  })

  it('当前这台连上了:地址 · 对面版本', () => {
    expect(hostSubtitle('ws://192.168.1.10:6789', ready, true)).toBe('192.168.1.10:6789 · 1.2.0')
  })

  it('★当前这台没连上就报**为什么**,不报地址 —— 这一行是断线时唯一说明原因的地方', () => {
    expect(hostSubtitle('ws://box:6789', { status: 'failed', error: '令牌不对' }, true)).toBe('连接失败:令牌不对')
    // state 还没建立起来(刚选中的那一帧)时说「未连接」,而不是拿地址假装一切正常。
    expect(hostSubtitle('ws://box:6789', null, true)).toBe('未连接')
  })

  it('ws:// 和 wss:// 都要剥掉,只留 主机:端口', () => {
    expect(hostSubtitle('wss://box:6789', null, false)).toBe('box:6789')
    expect(hostSubtitle('ws://box:6789', null, false)).toBe('box:6789')
  })
})

describe('顶栏那条主机横幅', () => {
  const READY = { status: 'ready', version: '1.2.0', methods: new Set<string>() } as const
  const URL = 'ws://192.168.1.7:7777'

  it('连上了就一句人话,跟微信「Mac 微信已登录」一个调调', () => {
    expect(hostBannerTitle('MacBook Pro', READY)).toBe('MacBook Pro 已连接')
  })

  it('★★连上了**不摆**地址和版本 —— 那串 mono 字是这条横幅存在的反面', () => {
    // 横幅的全部意义就是「正常的时候只说一句人话」。返回一个字符串(哪怕是空串)都会让
    // 调用方渲染出一个高度不为 0 的空行,顶栏白高一截 —— 必须是 null。
    expect(hostBannerDetail(URL, READY)).toBeNull()
  })

  it('★连不上时把**原因**抖出来,而且带上地址', () => {
    const d = hostBannerDetail(URL, { status: 'failed', error: '网络不可达' })
    expect(d).toContain('192.168.1.7:7777')
    expect(d).toContain('网络不可达')
    expect(d).not.toContain('ws://')   // 协议前缀是噪音,和 hostSubtitle 一个口径
  })

  it('★退避重连时也要说原因 —— 那时候人最想知道为什么', () => {
    const d = hostBannerDetail(URL, { status: 'retrying', attempt: 1, nextInMs: 3000, error: '连接被拒绝' })
    expect(d).toContain('连接被拒绝')
  })

  it('连接中:标题说连接中,细节只报地址(还没有原因可说)', () => {
    expect(hostBannerTitle('mini', { status: 'connecting', attempt: 1 })).toBe('mini 连接中…')
    expect(hostBannerDetail(URL, { status: 'connecting', attempt: 1 })).toBe('192.168.1.7:7777')
  })

  it('压根没选主机', () => {
    expect(hostBannerTitle('', null)).toBe('未选主机')
    expect(hostBannerDetail(URL, null)).toBe('192.168.1.7:7777')
  })

  it('★标题永远带得上主机名 —— 横幅回答的问题就是「我在遥控哪台电脑」', () => {
    for (const s of [READY, { status: 'connecting', attempt: 2 }, { status: 'failed', error: 'x' }] as const) {
      expect(hostBannerTitle('阿土伯的电脑', s)).toContain('阿土伯的电脑')
    }
  })
})
