import { describe, it, expect } from 'vitest'
import { pairLines, pairLink, pairAddress, type PairInfo } from './pairText'
import { parsePairingLink } from '@shared/remote/pairingLink'

const PUB = 'A'.repeat(43) + '='          // Ed25519 公钥 base64 是 44 个字符
const BASE: PairInfo = {
  host: '0.0.0.0', port: 6767, loopback: false,
  token: 'tok_ABC-123', pubKey: PUB, name: 'cloud-1',
  addresses: ['10.0.0.5', '172.17.0.1'],
  selfCmd: 'node out/main/daemon.js', canDrawQr: true,
}

const text = (i: Partial<PairInfo> = {}) => pairLines({ ...BASE, ...i }).join('\n')

describe('daemon pair 印出来的那一屏', () => {
  it('★印出来的配对码,手机端**解得开** —— 两边用的是同一份 pairingLink', () => {
    const r = parsePairingLink(pairLink(BASE))
    if (!r.ok) throw new Error(r.error)
    expect(r.value).toEqual({
      address: '10.0.0.5:6767', token: 'tok_ABC-123', label: 'cloud-1', pubKey: PUB, relay: undefined,
    })
  })

  it('★★云服务器:--address 覆盖网卡上那个内网地址', () => {
    // 云上网卡挂的是 10.x/172.x,手机要连的是公网那个。自动探测在这儿一定是错的。
    expect(pairAddress({ ...BASE, address: '203.0.113.9:6767' })).toBe('203.0.113.9:6767')
    expect(text({ address: '203.0.113.9:6767' })).toContain('ws://203.0.113.9:6767')
  })

  it('一个对外网卡都没有时回落成回环,**不许出现占位符**', () => {
    // 占位符进了码,手机端 parseAddress 过不去,现象是「扫进去了,但按不动保存」。
    const s = text({ addresses: [] })
    expect(pairAddress({ ...BASE, addresses: [] })).toBe('127.0.0.1:6767')
    expect(s).not.toMatch(/<.*地址.*>/)
    expect(s).toContain('--address')      // 而且要说清楚该怎么改
  })

  it('公钥总是带上 —— 直连那条路现在也端到端加密', () => {
    const r = parsePairingLink(pairLink({ ...BASE, relay: undefined }))
    expect(r.ok && r.value.pubKey).toBe(PUB)
  })

  it('给了 --relay 就把中转写进码里', () => {
    const r = parsePairingLink(pairLink({ ...BASE, relay: ' wss://r.example/ ' }))
    expect(r.ok && r.value.relay).toBe('wss://r.example/')
    expect(text({ relay: 'wss://r.example/' })).toContain('中转     wss://r.example/')
  })

  it('★令牌和公钥都摆在明面上,能直接粘', () => {
    const s = text()
    expect(s).toContain('访问令牌 tok_ABC-123')
    expect(s).toContain(`身份公钥 ${PUB}`)
  })

  it('不是 TTY 时不画码,但配对码照印', () => {
    const s = text({ canDrawQr: false })
    expect(s).toContain('画不了二维码')
    expect(s).toContain('myflowforge://add-host?')
  })

  it('多张网卡时把其余地址也列出来,并给出换一个的命令', () => {
    const s = text()
    expect(s).toContain('ws://172.17.0.1:6767')
    expect(s).toContain('pair --listen 0.0.0.0:6767 --address')
  })

  it('★绑回环时印 SSH 那条路,而且要告诉他手机走不了 SSH', () => {
    const s = text({ loopback: true, host: '127.0.0.1', token: '' })
    expect(s).toContain('通过 SSH 连接')
    expect(s).toContain('远端端口 6767')
    // 手机端只会拨 ws,没有 SSH 那一档。不说的话用户会在手机上找一个不存在的输入框。
    expect(s).toContain('--listen 0.0.0.0:6767')
    expect(s).not.toContain('myflowforge://')   // 回环地址的码扫了也连不上,不该印
  })

  it('绑回环但挂了中转时,照样出码 —— 中转那条路不需要对外端口', () => {
    const s = text({ loopback: true, host: '127.0.0.1', relay: 'wss://r.example/' })
    expect(s).toContain('myflowforge://add-host?')
    expect(s).toContain('中转     wss://r.example/')
  })
})
