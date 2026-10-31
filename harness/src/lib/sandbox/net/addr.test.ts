import { describe, expect, it } from 'vitest'
import { deniedClass, parseIp } from './addr'

describe('deniedClass', () => {
  const table: [string, ReturnType<typeof deniedClass>][] = [
    // IPv4
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'],
    ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'],
    ['169.254.1.1', 'link_local'],
    ['224.0.0.1', 'multicast'], ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'broadcast'], ['240.0.0.1', 'broadcast'],
    ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'], ['100.127.255.255', 'cgnat'],
    ['169.254.169.254', 'metadata'], ['169.254.170.2', 'metadata'], ['100.100.100.200', 'metadata'], ['168.63.129.16', 'metadata'],
    // IPv6
    ['::1', 'loopback'], ['::', 'unspecified'], ['fe80::1', 'link_local'], ['ff02::1', 'multicast'],
    ['fd00::1', 'ula'], ['fc00::1', 'ula'], ['fd00:ec2::254', 'metadata'], ['FE80::1%en0', 'link_local'],
    ['fe80::1%25en0', 'link_local'], ['::1%lo0', 'loopback'], ['::ffff:0:0', 'unspecified'], ['4294967295', 'broadcast'],
    // IPv6 里嵌着的 IPv4 按 IPv4 判
    ['::ffff:10.0.0.1', 'private'], ['::ffff:a00:1', 'private'], ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:169.254.169.254', 'metadata'], ['::ffff:0:10.0.0.1', 'private'], ['::10.0.0.1', 'private'], ['::127.0.0.1', 'loopback'],
    ['64:ff9b::7f00:1', 'loopback'], ['64:ff9b::10.0.0.1', 'private'], ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['2002:7f00:1::', 'loopback'], ['2002:a00:1::1', 'private'], ['2002:c0a8:101:1::1', 'private'],
    // 老式 IPv4 写法(inet_aton:十进制、八进制、十六进制、缩写)
    ['0x7f.1', 'loopback'], ['2130706433', 'loopback'], ['017700000001', 'loopback'], ['127.1', 'loopback'], ['0x7f000001', 'loopback'],
    ['0xa.0.0.1', 'private'], ['012.0.0.1', 'private'], ['0251.0376.0251.0376', 'metadata'],
    // 放行
    ['198.18.0.1', undefined], ['198.19.255.254', undefined], // fake-ip(Clash)段不拒
    ['8.8.8.8', undefined], ['140.82.112.3', undefined], ['172.32.0.1', undefined], ['100.128.0.1', undefined], ['11.0.0.1', undefined],
    ['2606:4700::1111', undefined], ['::ffff:8.8.8.8', undefined], ['64:ff9b::808:808', undefined], ['2002:808:808::', undefined],
    ['::ffff:198.18.0.1', undefined],
  ]
  it.each(table)('%s → %s', (ip, cls) => {
    expect(deniedClass(ip, [])).toBe(cls)
  })

  it('local interface addresses are denied, in any spelling', () => {
    const local = ['203.0.113.7', '2001:db8::7']
    expect(deniedClass('203.0.113.7', local)).toBe('local_interface')
    expect(deniedClass('::ffff:203.0.113.7', local)).toBe('local_interface')
    expect(deniedClass('2001:DB8:0:0::7', local)).toBe('local_interface')
    expect(deniedClass('203.0.113.8', local)).toBeUndefined()
    // 更具体的类先报
    expect(deniedClass('10.0.0.5', ['10.0.0.5'])).toBe('private')
  })

  it('anything that is not an IP is treated as denied (fail closed)', () => {
    for (const s of ['', 'example.com', '1.2.3.999', '::g', '1.2.3.4.5', ' 8.8.8.8']) expect(deniedClass(s, []), s).toBe('unspecified')
  })
})

describe('parseIp', () => {
  it('canonicalises both families', () => {
    expect(parseIp('0x7f.1')).toEqual({ family: 4, text: '127.0.0.1' })
    expect(parseIp('[::FFFF:10.0.0.1]')).toEqual({ family: 6, text: '::ffff:a00:1' })
    expect(parseIp('2001:DB8:0:0:0:0:0:1')).toEqual({ family: 6, text: '2001:db8::1' })
    expect(parseIp('example.com')).toBeUndefined()
  })
})
