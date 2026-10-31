import { describe, expect, it } from 'vitest'
import { DEFAULT_NETWORK_ALLOW } from '../../permissions/rules'
import { allowedBy, checkHost, normalizeHost, validateNetworkEntry } from './domains'

describe('normalizeHost', () => {
  it.each([
    ['Registry.NPMJS.org.', 'registry.npmjs.org'],
    ['github.com', 'github.com'],
    ['[::1]', '::1'], ['[::FFFF:10.0.0.1]', '::ffff:a00:1'], ['2001:DB8::1', '2001:db8::1'],
    ['0x7f.1', '127.0.0.1'], ['2130706433', '127.0.0.1'], ['017700000001', '127.0.0.1'], ['127.0.0.1.', '127.0.0.1'],
    // IDN → punycode,大小写折叠
    ['BÜCHER.de', 'xn--bcher-kva.de'], ['XN--BCHER-KVA.DE', 'xn--bcher-kva.de'], ['bücher.de.', 'xn--bcher-kva.de'],
    ['evil。github.com', 'evil.github.com'], ['ＧＩＴＨＵＢ.com', 'github.com'],
    ['a_b.example', 'a_b.example'], ['localhost.', 'localhost'],
    // 结尾的全角 / 句号式点与 ASCII 点一样去掉
    ['github.com。', 'github.com'], ['github.com．', 'github.com'], ['github.com｡', 'github.com'],
    // 钉住会折叠到白名单名字的写法(M1 依赖调用方只用规范化结果)
    ['git\u00adhub.com', 'github.com'], ['git\u200bhub.com', 'github.com'], ['github．com', 'github.com'], ['ⓖithub.com', 'github.com'],
    ['githuᵇ.com', 'github.com'], ['ſtatic.crates.io', 'static.crates.io'],
  ])('%s → %s', (h, want) => {
    expect(normalizeHost(h)).toBe(want)
  })

  it.each([
    '', '.', 'a..b', '.a', 'github.com..', 'github.com。。', 'github.com.。', `${'a'.repeat(64)}.com`, 'ex%41mple.com', 'u@github.com', 'git hub.com', ' github.com',
    'github.com:443', 'a/b', '*.github.com', '1.2.3.999', 'xn--zz.com', '[github.com]', '[::1', '::g', 'fe80::1%en0', 'a\u0000b',
    `${'a.'.repeat(127)}com`,
  ])('%j → undefined', h => {
    expect(normalizeHost(h)).toBeUndefined()
  })

  it('a 63-char label is fine', () => {
    expect(normalizeHost(`${'a'.repeat(63)}.com`)).toBe(`${'a'.repeat(63)}.com`)
  })
})

describe('allowedBy', () => {
  it('a bare host entry allows only 80 and 443 on that exact host', () => {
    const list = ['github.com']
    expect(allowedBy(list, 'github.com', 443)).toBe(true)
    expect(allowedBy(list, 'github.com', 80)).toBe(true)
    expect(allowedBy(list, 'github.com', 22)).toBe(false)
    expect(allowedBy(list, 'api.github.com', 443)).toBe(false)
    expect(allowedBy(list, 'evilgithub.com', 443)).toBe(false)
    expect(allowedBy(list, 'github.com.evil.com', 443)).toBe(false)
    expect(allowedBy(list, 'GitHub.COM.', 443)).toBe(true)
  })

  it('host:port and host:* entries', () => {
    expect(allowedBy(['github.com:22'], 'github.com', 22)).toBe(true)
    expect(allowedBy(['github.com:22'], 'github.com', 443)).toBe(false)
    expect(allowedBy(['github.com:*'], 'github.com', 8443)).toBe(true)
    expect(allowedBy(['github.com:*'], 'api.github.com', 443)).toBe(false)
  })

  it('*.d matches subdomains only, never d itself or a suffix lookalike', () => {
    const list = ['*.github.com']
    expect(allowedBy(list, 'api.github.com', 443)).toBe(true)
    expect(allowedBy(list, 'a.b.github.com', 443)).toBe(true)
    expect(allowedBy(list, 'github.com', 443)).toBe(false)
    expect(allowedBy(list, 'evilgithub.com', 443)).toBe(false)
    expect(allowedBy(list, 'api.evilgithub.com', 443)).toBe(false)
    expect(allowedBy(list, 'api.github.com', 22)).toBe(false)
    expect(allowedBy(['*.github.com:*'], 'api.github.com', 22)).toBe(true)
    expect(allowedBy(['*.github.com:*'], 'github.com', 22)).toBe(false)
  })

  it('entries and hosts are compared after the same normalisation (IDN, case, trailing dot)', () => {
    expect(allowedBy(['bücher.de'], 'XN--BCHER-KVA.DE.', 443)).toBe(true)
    expect(allowedBy(['*.BÜCHER.de.'], 'www.xn--bcher-kva.de', 443)).toBe(true)
    expect(allowedBy(['Registry.NPMJS.org.'], 'registry.npmjs.org', 443)).toBe(true)
  })

  it('IP literals match exactly (canonical form) and denied classes never match', () => {
    expect(allowedBy(['203.0.113.9'], '203.0.113.9', 443)).toBe(true)
    expect(allowedBy(['203.0.113.9'], '203.0.113.10', 443)).toBe(false)
    expect(allowedBy(['203.0.113.9:8080'], '203.0.113.9', 8080)).toBe(true)
    expect(allowedBy(['[2001:db8::9]:*'], '2001:DB8:0::9', 22)).toBe(true)
    expect(allowedBy(['[2001:db8::9]'], '[2001:db8::9]', 443)).toBe(true)
    expect(allowedBy(['198.18.0.1'], '198.18.0.1', 443)).toBe(true)
    // 拒绝类:列出了也不放
    expect(allowedBy(['127.0.0.1', '10.0.0.1:*', '169.254.169.254'], '127.0.0.1', 443)).toBe(false)
    expect(allowedBy(['127.0.0.1', '10.0.0.1:*', '169.254.169.254'], '0x7f.1', 443)).toBe(false)
    expect(allowedBy(['127.0.0.1', '10.0.0.1:*', '169.254.169.254'], '::ffff:10.0.0.1', 443)).toBe(false)
    expect(allowedBy(['127.0.0.1', '10.0.0.1:*', '169.254.169.254'], '169.254.169.254', 80)).toBe(false)
    // 域名条目不匹配 IP,通配也不匹配 IP
    expect(allowedBy(['*.0.0.1', 'github.com'], '140.82.112.3', 443)).toBe(false)
  })

  it('the empty list allows nothing; bad hosts and ports never match', () => {
    expect(allowedBy([], 'registry.npmjs.org', 443)).toBe(false)
    expect(allowedBy(['github.com'], '', 443)).toBe(false)
    expect(allowedBy(['github.com'], 'u@github.com', 443)).toBe(false)
    expect(allowedBy(['github.com:*'], 'github.com', 0)).toBe(false)
    expect(allowedBy(['github.com:*'], 'github.com', 65536)).toBe(false)
    expect(allowedBy(['github.com:*'], 'github.com', 1.5)).toBe(false)
    expect(allowedBy(['nonsense entry', '*', ''], 'github.com', 443)).toBe(false)
  })

  it('the default list allows its hosts on 443 only', () => {
    expect(allowedBy([...DEFAULT_NETWORK_ALLOW], 'registry.npmjs.org', 443)).toBe(true)
    expect(allowedBy([...DEFAULT_NETWORK_ALLOW], 'registry.npmjs.org', 5432)).toBe(false)
    expect(allowedBy([...DEFAULT_NETWORK_ALLOW], 'evil.example', 443)).toBe(false)
  })
})

describe('checkHost', () => {
  it('returns the normalised host that was checked, so callers never dial the raw string', () => {
    expect(checkHost(['github.com'], 'git\u00adhub.com', 443)).toEqual({ allowed: true, host: 'github.com' })
    expect(checkHost(['github.com'], 'GitHub.COM。', 443)).toEqual({ allowed: true, host: 'github.com' })
    expect(checkHost(['github.com'], '0x7f.1', 443)).toEqual({ allowed: false, host: '127.0.0.1' })
    expect(checkHost(['github.com'], 'evil.example', 443)).toEqual({ allowed: false, host: 'evil.example' })
    expect(checkHost(['github.com'], 'github.com', 0)).toEqual({ allowed: false, host: 'github.com' })
    expect(checkHost(['github.com'], 'u@github.com', 443)).toEqual({ allowed: false })
  })

  it('localhost names are never allowed, whatever the list says', () => {
    expect(checkHost(['localhost:*', '*.localhost'], 'localhost', 5432).allowed).toBe(false)
    expect(allowedBy(['localhost:*', '*.localhost'], 'db.localhost', 443)).toBe(false)
    expect(allowedBy(['*.localhost:*'], 'LOCALHOST.', 443)).toBe(false)
  })
})

describe('validateNetworkEntry', () => {
  it.each([
    'github.com', 'github.com:22', 'github.com:*', '*.github.com', '*.github.com:8443', 'Registry.NPMJS.org.', 'bücher.de',
    '203.0.113.9', '203.0.113.9:8080', '[2001:db8::9]', '[2001:db8::9]:*', '2001:db8::9', '198.18.0.1', ...DEFAULT_NETWORK_ALLOW,
  ])('%j is valid', e => {
    expect(validateNetworkEntry(e)).toBe(true)
  })

  it.each([
    '', '  ', ' github.com', '*', '*.', '*github.com', 'a.*.github.com', '*.*.github.com', 'github.com:', 'github.com:0', 'github.com:65536',
    'github.com:080', 'github.com:22:22', 'github.com:-1', 'github.com:http', 'u@github.com', 'github%2ecom', 'https://github.com',
    'github.com/path', '[2001:db8::9]:', '[github.com]:443', '*.203.0.113.9', '*.[::1]',
    // 拒绝类地址永远不会被放行,写进来就是错
    '127.0.0.1', '10.0.0.1:443', '::1', 'localhost', 'localhost:*', 'LocalHost.', '*.localhost', 'foo.localhost:5432', '[::ffff:10.0.0.1]:*', '169.254.169.254', '0x7f.1', 'fd00::1',
    7, null, undefined, {},
  ] as unknown[])('%j is invalid', e => {
    expect(validateNetworkEntry(e)).toBe(false)
  })
})
