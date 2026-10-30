import { describe, expect, it } from 'vitest'
import { redact } from './redact'

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun',
  'VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

describe('redact', () => {
  it.each([
    ['openai key', 'key=sk-proj-abcdefghij0123456789xyz end', 'key=*** end'],
    ['anthropic key', 'sk-ant-api03-AbC_dEf-0123456789abcdef', '***'],
    ['short sk- is not a key', 'sk-short', 'sk-short'],
    ['ghp', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token ***'],
    ['gho', 'gho_abcdefghijklmnopqrstuvwxyz0123456789', '***'],
    ['github_pat', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789', '***'],
    ['slack bot', 'xoxb-123456789012-abcdefghijkl', '***'],
    ['slack user', 'xoxp-1234-5678-abcdef0123', '***'],
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', '***'],
    ['AKIA too short', 'AKIA123', 'AKIA123'],
    ['pem multi-line', `before\n${PEM}\nafter`, 'before\n***\nafter'],
    ['pem generic', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----', '***'],
    ['pem openssh', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----', '***'],
    ['pem without END is masked to the end', 'x\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\nmore', 'x\n***'],
    ['public key untouched', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----'],
    // JSON 字符串里的转义:`\n` 后紧跟密钥,也要打码
    ['after a JSON escape', '{"c":"a\\nsk-abcdefghijklmnopqrstu"}', '{"c":"a\\n***"}'],
    ['pem inside JSON', `{"c":"${PEM.replace(/\n/g, '\\n')}"}`, '{"c":"***"}'],
    ['two keys', 'sk-aaaaaaaaaaaaaaaaaaaa and AKIAABCDEFGHIJKLMNOP', '*** and ***'],
    ['plain text', 'nothing secret here', 'nothing secret here'],
  ])('%s', (_name, input, out) => {
    expect(redact(input)).toBe(out)
  })
})
