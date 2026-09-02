import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ★把落盘换成一个内存里的对象。`readJson`/`writeJson` 是 `config/store` 的,
 *  mock 它俩就够 —— 不用碰真的 `~/.myFlowForge/hosts.json`。
 */
let disk: unknown = undefined
vi.mock('../config/paths', () => ({ sysFile: (n: string) => `/fake/${n}` }))
vi.mock('../config/store', () => ({
  // ★`fallback` 是个**函数**不是值(见 config/store.ts 的签名)。第一版当成值传,
  // 于是 readHosts() 返回的是那个函数本身 —— `f.hosts` 是 undefined,四条用例一起炸。
  readJson: (_f: string, schema: { parse: (v: unknown) => unknown }, fallback: () => unknown) =>
    disk === undefined ? fallback() : schema.parse(disk),
  writeJson: (_f: string, v: unknown) => { disk = v },
}))

import { upsertHost, readHosts, exportHosts, importHosts } from './hostStore'

const BASE = {
  label: '书房的 Mac',
  kind: 'direct' as const,
  address: 'ws://192.168.1.9:6789',
  sshTarget: '',
  icon: '🖥️',
  display: 'both' as const,
  token: 'tok-abc',
  pubKey: `${'A'.repeat(43)}=`,
  relay: 'wss://relay.example/',
}

beforeEach(() => { disk = undefined })

describe('远程主机存盘', () => {
  /**
   * ★★这一条防的是一个**具体的、已经发生过一次的** bug:`upsertHost` 里那个 `next` 是一张
   *  **显式字段列表**,schema 加了字段而它没跟上,新字段就在保存时静默消失 —— 两边看起来都对,
   *  typecheck 也不会说话(字段是可选的)。
   *  手机端的 `loadHosts` 就是这么丢掉 `pubKey`/`relay` 的:配好的中转主机**重启 app 就退回
   *  明文直连、然后连不上**,而界面上只写着「连接失败」。同一个形状,这次先钉住。
   */
  it('★★存进去再读出来,一个字段都不许少', () => {
    const saved = upsertHost({ ...BASE })
    expect(saved.pubKey).toBe(BASE.pubKey)
    expect(saved.relay).toBe(BASE.relay)
    const back = readHosts().hosts[0]
    expect(back).toMatchObject(BASE)
  })

  it('改一台已有的主机,没动的字段原样留着', () => {
    const h = upsertHost({ ...BASE })
    upsertHost({ ...BASE, id: h.id, label: '换个名字' })
    const back = readHosts().hosts[0]
    expect(back.label).toBe('换个名字')
    expect(back.pubKey, 'pubKey 不该被改名冲掉').toBe(BASE.pubKey)
    expect(back.relay, 'relay 不该被改名冲掉').toBe(BASE.relay)
  })

  it('老记录(没有这两个字段)读出来是空串,不是 undefined —— 下游只判真假', () => {
    const { pubKey: _p, relay: _r, ...old } = BASE
    disk = { version: 1, hosts: [{ id: 'h1', ...old, lastConnectedAt: 0 }] }
    const back = readHosts().hosts[0]
    expect(back.pubKey).toBe('')
    expect(back.relay).toBe('')
  })
})

describe('导出 / 导入', () => {
  /**
   * ★公钥和中转地址**不是凭据**:公钥按定义就是公开的,中转地址只是个地址。
   *  所以它们跟着导出,不受 `includeTokens` 管 —— 不带的话,导出的中转主机到了另一台设备上
   *  会退化成一条「连不上的明文直连记录」,而那条记录看起来完全正常。
   */
  it('★不含令牌的导出里,公钥和中转地址仍然在', () => {
    upsertHost({ ...BASE })
    const text = exportHosts({ includeTokens: false })
    const j = JSON.parse(text)
    expect(j.hosts[0].token, '令牌不该带').toBe('')
    expect(j.hosts[0].pubKey).toBe(BASE.pubKey)
    expect(j.hosts[0].relay).toBe(BASE.relay)
  })

  /**
   * ★★这一条钉的是一个**既有 bug**(2026-09-02 撞出来的):`exportHosts` 不写 `id`,
   *  而落盘那张 schema 的 `id: z.string()` 没有 `.catch()` ⇒ 拿它 parse 导出的内容会整份失败,
   *  报「里面没有可导入的主机」。也就是说「在设备之间搬清单」这个功能**一直是不工作的**,
   *  而且失败得很像「你给的文件不对」,没人会去怀疑是自己导出的那份有问题。
   */
  it('★★自己导出的东西必须自己导得回来(老字段那部分,和新字段无关)', () => {
    upsertHost({ ...BASE, pubKey: '', relay: '' })
    const r = importHosts(exportHosts({ includeTokens: false }))
    expect(r.ok, r.ok ? '' : r.error).toBe(true)
  })

  it('★导出再导入,这台主机还是走中转、还是加密的', () => {
    upsertHost({ ...BASE })
    const text = exportHosts({ includeTokens: true })
    disk = undefined                                  // 换一台设备
    const r = importHosts(text)
    expect(r.ok).toBe(true)
    const back = readHosts().hosts[0]
    expect(back).toMatchObject({ pubKey: BASE.pubKey, relay: BASE.relay, token: BASE.token })
  })
})
