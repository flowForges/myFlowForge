import { describe, expect, it } from 'vitest'
import { stableText } from './holdback'

describe('stableText', () => {
  it('final releases everything', () => {
    expect(stableText('password=abc', true)).toBe('password=abc')
  })
  it('holds the trailing ASCII run, not CJK', () => {
    expect(stableText('你好 ghp_abcdef', false)).toBe('你好 ')
    expect(stableText('密钥之外的中文', false)).toBe('')
    expect(stableText('今天天气很好abc', false)).toBe('今天天气很好')
    expect(stableText('今天天气很好', false)).toBe('今天天气很好')
    expect(stableText('hello world ', false)).toBe('hello world ')
  })
  it('holds the current line when it has a risk marker', () => {
    expect(stableText('first line\nthe password is hunt', false)).toBe('first line\n')
    expect(stableText('first\nsecond line done\nBearer ', false)).toBe('first\nsecond line done\n')
    expect(stableText('see https:// now ', false)).toBe('')
    expect(stableText('a\n密码 是 x ', false)).toBe('a\n')
    expect(stableText('a\nb\n', false)).toBe('a\nb\n')
  })
  it('holds from an unclosed BEGIN', () => {
    const pem = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nMIIEow\n'
    expect(stableText('before\n' + pem, false)).toBe('before\n')
    expect(stableText('before\n' + pem + '-----END RSA PRIVATE KEY-----\nafter ', false)).toBe('before\n' + pem + '-----END RSA PRIVATE KEY-----\nafter ')
  })
})
