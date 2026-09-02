import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { MobileSection } from './MobileSection'
import { parsePairingLink } from '@shared/remote/pairingLink'

/**
 * ★把真的 `QrCode` 换成一个只把喂进来的字符串挂在 `data-text` 上的壳。
 *  真码的位矩阵在 `QrCode.test.tsx` 里钉,这里要钉的是**另一件事**:这一屏往里喂的
 *  是不是一条手机真能用的配对链接。不换的话内容只存在于像素里,读不回来 ——
 *  上一版的测试注释写着「码的内容不能从像素里读回来」,于是「令牌/公钥/中转地址有没有
 *  进到码里」整个是零覆盖,而那正是「扫了没反应」唯一的藏身处。
 */
vi.mock('./QrCode', () => ({
  QrCode: ({ text, alt }: { text: string; alt?: string }) => (
    <svg className="qr" aria-label={alt} data-text={text} />
  ),
}))

const RUNNING = {
  running: true, host: '0.0.0.0', port: 6789, token: 'tok-ABC_123',
  addresses: ['192.168.110.133', '10.211.55.2'], clients: 0, error: '', name: '书房的 Mac',
}

/** Ed25519 公钥 base64 是 44 个字符 —— 长度不对 `parsePairingLink` 会整条拒掉。 */
const PUBKEY = `${'A'.repeat(43)}=`

type RelayView = {
  enabled: boolean
  url: string
  detail: { status: string; error?: string; peers?: number }
  publicKey: string
  token: string
}

/**
 * `relay` 传 undefined = 这台机器的 preload 里根本没有中转那几个方法(旧版本)。
 * 传对象 = 有,按对象里的字段回答。
 */
const mount = async (status: unknown, relay?: Partial<RelayView>) => {
  const r: RelayView | null = relay
    ? { enabled: false, url: '', detail: { status: 'off' }, publicKey: PUBKEY, token: 'relay-tok', ...relay }
    : null
  ;(window as unknown as { forge: unknown }).forge = {
    mobileStatus: vi.fn(async () => status),
    mobileApply: vi.fn(async () => status),
    mobileRegenToken: vi.fn(async () => status),
    onMobileStatus: () => () => {},
    ...(r ? { relayStatus: vi.fn(async () => r), onRelayStatus: () => () => {}, relayApply: vi.fn(async () => r) } : {}),
  }
  render(<MobileSection />)
  await waitFor(() => expect(screen.getByText('让手机连进来')).toBeTruthy())
  // 中转状态是第二个异步来源,等它也落地 —— 不等的话「只开中转」那几条会在 relay 还是 null 时断言。
  if (r?.enabled) await waitFor(() => expect(document.querySelector('button.toggle.on[aria-label="出门也能连"]')).toBeTruthy())
}

/** 点开码,把喂给 QrCode 的那条链接解回来。 */
const openAndParse = async () => {
  await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })
  const svg = document.querySelector('svg.qr')!
  const r = parsePairingLink(svg.getAttribute('data-text') ?? '')
  if (!r.ok) throw new Error(`这一屏出的码手机端解不开:${r.error}`)
  return r.value
}

beforeEach(() => vi.clearAllMocks())

describe('配对二维码', () => {
  it('★默认不画 —— 码里带着令牌,不能替人在共享屏幕上把钥匙亮出来', async () => {
    await mount(RUNNING)
    expect(document.querySelector('svg.qr')).toBeNull()
    expect(screen.getByText('显示配对二维码')).toBeTruthy()
  })

  it('点开之后画出来的码,解回来就是地址 + 令牌 + 机器名', async () => {
    await mount(RUNNING)
    const v = await openAndParse()
    expect(v).toEqual({ address: '192.168.110.133:6789', token: 'tok-ABC_123', label: '书房的 Mac' })
    // 喂进去的是**第一个**地址(虚拟网卡 10.211.55.x 是 Parallels 的,手机永远连不上那个)。
    expect(document.querySelector('svg.qr')?.getAttribute('aria-label')).toBe('配对二维码 · 192.168.110.133:6789')
  })

  it('★局域网直连的码也带公钥 —— 直连那条路现在也走端到端加密', async () => {
    // ★★这条钉的是 2026-09-02 那个补丁**被删掉**这件事。在 `gateway.ts` 会握手之前,
    //  带公钥的码在局域网上是连不上的(客户端发 hs-init,网关回明文 hello),
    //  所以码里一度只在开中转时才带公钥。现在服务端两条路都会握手,直连也必须带 ——
    //  不带 = 手机在自家 wifi 上跑明文,令牌和全部对话内容都在网线上。
    await mount(RUNNING, { enabled: false })
    const v = await openAndParse()
    expect(v.pubKey).toBe(PUBKEY)
    expect(v.relay).toBeUndefined()
  })

  it('能收回去', async () => {
    await mount(RUNNING)
    await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })
    await act(async () => { fireEvent.click(screen.getByText('收起二维码')) })
    expect(document.querySelector('svg.qr')).toBeNull()
  })

  it('★连着一台跑旧版本的主机(status 里没有 name)不能把整屏炸成白板', async () => {
    const { name: _drop, ...old } = RUNNING
    await mount(old)
    await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })
    expect(document.querySelector('svg.qr')).toBeTruthy()
    expect(screen.getByText('让手机连进来')).toBeTruthy()
  })

  it('★网关和中转**都**关着,才是真的没码可扫', async () => {
    await mount({ ...RUNNING, running: false }, { enabled: false })
    expect(screen.queryByText('显示配对二维码')).toBeNull()
  })

  it('旧 preload 里根本没有中转那几个方法时,按老样子只看网关', async () => {
    await mount({ ...RUNNING, running: false })
    expect(screen.queryByText('显示配对二维码')).toBeNull()
  })
})

/**
 * ★★这一组是 2026-08-31 真机上撞出来的:用户在第二台电脑上**只开了中转**,
 *  整屏没有任何「显示配对二维码」—— 于是手机根本没法配对,而设计文档决策 6 明说
 *  直连和中转是**平级**的两条路。原来那一整块(含二维码)被 `st.running &&` 挡着。
 */
describe('只开中转(局域网网关关着)', () => {
  const RELAY_ON = { enabled: true, url: 'wss://relay.example/' }
  const OFF = { ...RUNNING, running: false }

  it('★照样出码 —— 只开中转的人恰恰是最需要这枚码的那个', async () => {
    await mount(OFF, RELAY_ON)
    expect(screen.getByText('显示配对二维码')).toBeTruthy()
  })

  it('码里带着公钥和中转地址 —— 少任何一个手机端都会拒扫', async () => {
    await mount(OFF, RELAY_ON)
    const v = await openAndParse()
    expect(v.pubKey).toBe(PUBKEY)
    expect(v.relay).toBe('wss://relay.example/')
  })

  it('★网关绑回环、`status.token` 是空串时,中转那把令牌顶上来', async () => {
    // 中转那条路上 daemon 一样开着令牌校验(`relayController.ts` 用的就是 `ensureToken()`),
    // 出一枚没令牌的码,手机走中转会在握手后被 4403 断掉 —— 界面上只显示「连接失败」。
    await mount({ ...OFF, host: '127.0.0.1', token: '' }, RELAY_ON)
    const v = await openAndParse()
    expect(v.token).toBe('relay-tok')
  })

  it('★这台机器一个局域网地址都没有时,地址回落成回环 —— 不能填占位符', async () => {
    // `<这台机器的地址>` 那串占位符进了码,手机端 `parseAddress` 会当场拒绝保存
    //  (走中转也一样要过那道校验),现象是「扫进去了,但按不动保存」。
    await mount({ ...OFF, addresses: [] }, RELAY_ON)
    const v = await openAndParse()
    expect(v.address).toBe('127.0.0.1:6789')
  })

  it('中转开着但地址是空的,不算开着 —— 那时它连不上任何地方', async () => {
    await mount(OFF, { enabled: true, url: '' })
    expect(screen.queryByText('显示配对二维码')).toBeNull()
  })

  it('★不摆手填用的「地址 / 令牌」两个框 —— 手填出来的记录没有公钥,连不上', async () => {
    await mount(OFF, RELAY_ON)
    expect(document.querySelector('#mobAddr')).toBeNull()
    expect(document.querySelector('#mobToken')).toBeNull()
  })

  it('★不再说「手机和电脑要在同一个网络里」—— 走中转时那句话是错的', async () => {
    await mount(OFF, RELAY_ON)
    await act(async () => { fireEvent.click(screen.getByText('显示配对二维码')) })
    expect(screen.queryByText(/同一个网络/)).toBeNull()
  })

  it('网关和中转**都**开着时,两样都摆:手填的框在,码里也带着中转地址', async () => {
    await mount(RUNNING, RELAY_ON)
    expect(document.querySelector('#mobAddr')).toBeTruthy()
    const v = await openAndParse()
    expect(v.relay).toBe('wss://relay.example/')
    expect(v.token).toBe('tok-ABC_123')
  })
})

describe('「我手机连上没有」', () => {
  it('★答案在开关旁边,不在二维码底下 —— 而且是**没展开二维码时**就看得见', async () => {
    await mount({ ...RUNNING, clients: 1 })
    // 二维码还折着
    expect(document.querySelector('svg.qr')).toBeNull()
    const live = document.querySelector('.hosts-live')!
    expect(live.textContent).toContain('现在连着')
    expect(live.textContent).toContain('1')
    expect(live.className).toContain('on')
  })

  it('没有设备连着时说的是「在哪个地址上等着」,不是干巴巴一个 0', async () => {
    await mount({ ...RUNNING, clients: 0 })
    const live = document.querySelector('.hosts-live')!
    expect(live.textContent).toContain('192.168.110.133:6789')
    expect(live.textContent).toContain('还没有设备连上来')
    expect(live.className).not.toContain('on')
  })

  it('网关关着就没有这条 —— 关着的时候「0 台设备」是废话', async () => {
    await mount({ ...RUNNING, running: false })
    expect(document.querySelector('.hosts-live')).toBeNull()
  })
})
