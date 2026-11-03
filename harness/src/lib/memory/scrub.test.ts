import { describe, expect, it } from 'vitest'
import { isRandomToken, scrub } from './scrub'

// 密钥全部运行时拼出来,仓库自己的扫描才不会报
const X = (n: number) => 'x'.repeat(n)
const mixed = (n: number, seed = 7) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  let v = seed
  for (let i = 0; i < n; i++) {
    // mulberry32:可重复,低位也够随机
    v = (v + 0x6d2b79f5) | 0
    let t = Math.imul(v ^ (v >>> 15), 1 | v)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    out += alphabet[((t ^ (t >>> 14)) >>> 0) % alphabet.length]
  }
  return out
}
const UPPER16 = 'ABCDEFGHIJKLMNOP'
const pem = (label: string) => ['-----BEGIN ' + label + ' PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', 'u1SU1LfVLPHCozMx', '-----END ' + label + ' PRIVATE KEY-----'].join('\n')
const jwt = () => ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0In0', 'c2lnbmF0dXJl'].join('.')

describe('scrub: spec §11 pattern table', () => {
  it.each<[string, string, string]>([
    // 现有 redact
    ['PEM spanning lines', `a\n${pem('RSA')}\nb`, 'a\n***\nb'],
    ['sk-', 'k ' + 'sk-' + X(24), 'k ***'],
    ['ghp_', 'ghp_' + X(36), '***'],
    ['github_pat_', 'github_pat_' + X(30), '***'],
    ['xox', 'xoxb-' + X(20), '***'],
    ['AKIA', 'AKIA' + UPPER16, '***'],
    // 更多前缀
    ['glpat-', 'glpat-' + X(20), '***'],
    ['npm_', 'npm_' + X(36), '***'],
    ['hf_', 'hf_' + X(34), '***'],
    ['AIza', 'AIza' + X(35), '***'],
    ['ya29.', 'ya29.' + X(40), '***'],
    ['ASIA', 'ASIA' + UPPER16, '***'],
    ['telegram bot token', 'bot ' + '123456789:' + X(35), 'bot ***'],
    // JWT
    ['JWT', 'cookie ' + jwt() + ' end', 'cookie *** end'],
    // 请求头
    ['Bearer', 'Bearer ' + mixed(12), 'Bearer ***'],
    ['bearer long lowercase', 'bearer ' + X(24), 'bearer ***'],
    ['Authorization header', 'Authorization: Basic ' + mixed(12), 'Authorization: ***'],
    ['Authorization with Bearer', 'Authorization: Bearer ' + mixed(12) + '\nnext', 'Authorization: ***\nnext'],
    ['Authorization in curl', `curl -H 'authorization: token ${mixed(12)}' u`, `curl -H 'authorization: ***' u`],
    ['Authorization in JSON', '{"Authorization":"Bearer ' + mixed(12) + '"}', '{"Authorization":"***"}'],
    // URL 账号
    ['URL account keeps host and port', 'postgres://u:p@10.0.0.5:5432/db', 'postgres://***@10.0.0.5:5432/db'],
    ['URL password containing @', 'mysql://u:p@ss@db.local:3306/x', 'mysql://***@db.local:3306/x'],
    // 标了名字的值
    ['password=', 'password=hunter2', 'password=***'],
    ['passwd:', 'passwd: hunter2', 'passwd: ***'],
    ['api_key=', 'api_key=abc', 'api_key=***'],
    ['apiKey in code', 'apiKey: "abc"', 'apiKey: "***"'],
    ['secret:', 'secret: abc', 'secret: ***'],
    ['token=', 'token=abc', 'token=***'],
    ['env name with prefix', 'DB_PASSWORD=abc\nX=1', 'DB_PASSWORD=***\nX=1'],
    ['camelCase label', 'accessToken: abc', 'accessToken: ***'],
    ['header style', 'X-Api-Key: abc', 'X-Api-Key: ***'],
    ['JSON value', '{"password":"a b","n":1}', '{"password":"***","n":1}'],
    ['JSON inside JSON', '{"c":"{\\"token\\":\\"abc\\"}"}', '{"c":"{\\"token\\":\\"***\\"}"}'],
    ['value before a JSON escape', '{"c":"password=abc\\nnext"}', '{"c":"password=***\\nnext"}'],
    ['unclosed quote', 'password="abc', 'password="***'],
    ['full-width colon', 'token:abc', 'token:***'],
    ['password is', 'my password is hunter2 ok', 'my password is *** ok'],
    ['密码是', '我的密码是hunter2,记一下', '我的密码是***,记一下'],
    ['密码是 with a space', '密码是 hunter2', '密码是 ***'],
    ['口令:', '口令:abc', '口令:***'],
    ['口令 half-width', '口令: abc', '口令: ***'],
    ['口令 then a word', '我的口令 hunter2 记一下', '我的口令 *** 记一下'],
    ['密钥为', '密钥为abc。', '密钥为***。'],
  ])('%s', (_n, input, want) => {
    expect(scrub(input).text).toBe(want)
    expect(scrub(input).masked).toBeGreaterThan(0)
  })

  it('high entropy: random mixed strings are masked, apart from the rare one that reads as words', () => {
    let tried = 0
    let missed = 0
    for (let seed = 1; seed <= 1000; seed++) {
      const s = mixed(40, seed)
      if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s)) continue
      tried++
      const text = scrub(`k ${s} end`).text
      if (text !== 'k *** end') missed++
      expect(text === 'k *** end' || !text.includes('***')).toBe(true)
    }
    expect(tried).toBeGreaterThan(950)
    expect(missed).toBeLessThanOrEqual(5)
  })

  it('high entropy: base64 with symbols and padding is one token', () => {
    const b64 = mixed(20, 3) + '+' + mixed(11, 4) + '/' + mixed(10, 5) + '=='
    expect(scrub(`value ${b64} end`).text).toBe('value *** end')
  })
})

describe('scrub: left alone', () => {
  it.each<[string, string]>([
    ['40-hex git SHA', 'commit ' + 'a1b2c3d4e5'.repeat(4)],
    ['upper and lower hex', 'AbCdEf0123'.repeat(4)],
    ['UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['camelCase identifier', 'getUserProfileByAccountIdentifierFromCache'],
    ['camelCase identifier with digits', 'getUserProfile2ByAccountIdentifierFromCache3'],
    ['identifier with an acronym and a digit', 'handleOAuth2CallbackForGitHubApp'],
    ['SCREAMING constant with digits', 'MY_VERY_LONG_CONSTANT_NAME_V2_WITH_SUFFIX'],
    ['long file path', '/Users/dev/work/some-project/src/components/settings/AdvancedNetworkPanel2.test.tsx'],
    ['long relative path, no dots', 'src/lib/a1/b2/x9/Foo3/Bar4/Baz5/qux6/v7/mod8'],
    ['kebab identifiers', 'risk-assessment-framework-for-version-2-and-more-Things'],
    ['connection string with no password', 'redis://10.0.0.5:6379/0'],
    ['ssh remote, user only', 'ssh://git@github.com:22/acme/app.git'],
    ['port in a URL', 'http://localhost:3000/a@b'],
    ['plain Chinese', '这个项目的包管理器用 pnpm,端口 5173'],
    ['the word bearer', 'Bearer tokens are not cookies. Bearer Authentication is fine.'],
    ['label without a value', 'token: \npassword:'],
    ['type annotations', 'password: string\ntoken: boolean\nsecret: undefined'],
    ['comparison and arrow', 'if (token === x) y(token => token)\npassword == y'],
    ['plural and suffixed words', 'tokens: 100, tokenCount: 3, password_hash: abc'],
    ['密码 as a topic', '密码错误,密钥 管理,密码是否正确'],
    ['password is, a sentence', 'the password is incorrect'],
    ['already masked', 'password=*** postgres://***@h:1/db Bearer *** Authorization: ***'],
    ['short sk-', 'sk-short'],
  ])('%s', (_n, input) => {
    expect(scrub(input)).toEqual({ text: input, masked: 0 })
  })
})

describe('scrub: order and counts', () => {
  it('cleans first, so a secret split by invisible characters is still masked', () => {
    const key = 'sk-' + X(24)
    const split = key.slice(0, 8) + '​' + key.slice(8, 16) + '\u{E0041}' + key.slice(16)
    expect(scrub(`x ${split} y`).text).toBe('x *** y')
    expect(scrub('pass​word=hunter2').text).toBe('password=***')
    expect(scrub('\u001b[31mtoken\u001b[0m=abc').text).toBe('token=***')
  })

  it('masked counts every replacement, from redact and from the table', () => {
    expect(scrub('nothing').masked).toBe(0)
    expect(scrub('sk-' + X(24)).masked).toBe(1)
    expect(scrub(`${'sk-' + X(24)} ${'AKIA' + UPPER16} password=x postgres://u:p@h:1/d`).masked).toBe(4)
  })

  it('a mask that was already there does not count', () => {
    expect(scrub('**** *** sk-' + X(24)).masked).toBe(1)
  })

  it('is idempotent: text stays and the second pass masks nothing', () => {
    const inputs = [
      `a\n${pem('RSA')}\nb`,
      'sk-' + X(24) + '&x=1',
      'token=' + 'sk-' + X(24) + '&x=1',
      'postgres://u:' + 'sk-' + X(24) + '@h:5432/db',
      'Authorization: Bearer ' + mixed(20),
      'token: Bearer ' + mixed(20),
      '{"password":"a b"}',
      'password="abc',
      '密码是abc,口令 def',
      `value ${mixed(40)} and ${jwt()}`,
      'my password is hunter2',
    ]
    for (const s of inputs) {
      const once = scrub(s)
      expect(scrub(once.text), s).toEqual({ text: once.text, masked: 0 })
    }
  })
})

describe('scrub: known gaps (spec §11 accounting; changing one means updating the spec on purpose)', () => {
  it('known gap: unlabelled low-entropy secret stays', () => {
    expect(scrub('那个东西是 hunter2').text).toContain('hunter2')
    expect(scrub('the thing is hunter2').text).toContain('hunter2')
  })
  it('known gap: unlabelled 40-hex key stays', () => {
    const key = '0123456789abcdef0123'.repeat(2)
    expect(scrub(`key ${key}`).text).toContain(key)
  })
  it('known gap: a random string that happens to read as words stays (about 0.1% of 40-char ones)', () => {
    const lucky = ['XFThDfHpjtpVgaWM', 'QMiUipiGqygekqKI', 'NHI6qdjx'].join('')
    expect(scrub(lucky).text).toBe(lucky)
  })
  it('known gap: a secret split across two messages stays', () => {
    const key = 'sk-' + X(24)
    expect(scrub(key.slice(0, 10)).text + scrub(key.slice(10)).text).toBe(key)
  })
})

describe('scrub: 1 MB in under 200 ms', () => {
  const MB = 1024 * 1024
  const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length)).slice(0, MB)
  // 一次慢不算:测试机可能正忙。取三次里最快的
  const fastest = (s: string) => {
    let best = Infinity
    for (let i = 0; i < 3; i++) {
      const t = performance.now()
      scrub(s)
      best = Math.min(best, performance.now() - t)
    }
    return best
  }
  it.each<[string, string]>([
    ['prose', fill('the quick brown fox jumps over the lazy dog. ')],
    ['one long word', fill('a')],
    ['repeated JWT heads', fill('eyJ')],
    ['JWT heads with dashes', fill('eyJ-')],
    ['URL heads', fill('://')],
    ['URL with colons and no @', '://' + fill('a:')],
    ['repeated labels', fill('password=')],
    ['repeated quoted labels', fill('password="')],
    ['labels and spaces', fill('token ')],
    ['one label, then spaces', 'token' + fill(' ')],
    ['31-char runs', fill('aB3'.repeat(10) + 'x.')],
    ['digits', fill('1')],
    ['digits and colons', fill('123456789:')],
    ['repeated PEM heads', fill('-----BEGIN ')],
    ['one base64 blob', fill(mixed(997))],
    ['Chinese labels', fill('密码是')],
    ['repeated Authorization', fill('authorization')],
    ['invisible characters', fill('​')],
    ['newlines', fill('\r\n')],
  ])('%s', (_n, s) => {
    expect(fastest(s)).toBeLessThan(200)
  })
})

describe('isRandomToken', () => {
  it('wants all three character classes', () => {
    expect(isRandomToken(mixed(40))).toBe(true)
    expect(isRandomToken('abcdefghijklmnopqrstuvwxyzabcdefghijklm')).toBe(false)
    expect(isRandomToken('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD')).toBe(false)
  })
})
