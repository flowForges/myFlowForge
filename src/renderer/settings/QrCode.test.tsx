import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { QrCode } from './QrCode'
import { buildPairingLink } from '@shared/remote/pairingLink'

/** 现实里最密的那一份:43 字符的 base64url 令牌(32 字节)+ 中文机器名(percent 编码后一个字 9 个字符)。 */
const WORST = buildPairingLink({
  address: '192.168.110.133:6789',
  token: 'Yl3pQ7xK2mNvR8sT1uW4zA6bC9dE0fG5hJ7kL2nP4qS',
  label: '书房的 MacBook Pro',
})

const modulesOf = (text: string) => {
  const { container } = render(<QrCode text={text} />)
  const vb = container.querySelector('svg')!.getAttribute('viewBox')!.split(' ')
  return Number(vb[2]) - 8 // viewBox 里含 4 格静区,两边共 8
}

describe('QrCode', () => {
  it('★码不能悄悄变密。', () => {
    // 192px 显示、49 模块 ≈ 3.5 CSS px 一格,实测(CoreImage,和 iOS 相机同一套检测器)
    // 一直到 96px 都还能解出来 —— 也就是说现在有一倍多的余量。
    // 往链接里再加字段会把版本顶上去、格子变小,而**症状是「有的人扫得出有的人扫不出」**,
    // 不会有任何东西变红。所以在这儿钉一个上限:超了就回去想想那个字段是不是非放码里不可。
    expect(modulesOf(WORST)).toBeLessThanOrEqual(53)
  })

  it('静区是四格 —— 贴边的码很多相机直接不认', () => {
    const { container } = render(<QrCode text="myflowforge://add-host?v=1&a=1.2.3.4%3A6789" />)
    const svg = container.querySelector('svg')!
    const [, , w] = svg.getAttribute('viewBox')!.split(' ').map(Number)
    // 所有黑块的坐标都 >= 4 且 < w-4
    const d = svg.querySelector('path')!.getAttribute('d')!
    const xs = [...d.matchAll(/M(\d+) (\d+)h/g)].flatMap((m) => [Number(m[1]), Number(m[2])])
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(4)
    expect(Math.max(...xs)).toBeLessThan(w - 4)
  })

  it('白底黑块是写死的,不跟皮肤走 —— 反相码不是所有扫码器都认', () => {
    const { container } = render(<QrCode text="myflowforge://add-host?v=1&a=1.2.3.4%3A6789" />)
    expect(container.querySelector('rect')!.getAttribute('fill')).toBe('#fff')
    expect(container.querySelector('path')!.getAttribute('fill')).toBe('#000')
  })
})
