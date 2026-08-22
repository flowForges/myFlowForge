import { describe, it, expect } from 'vitest'
import { isLoopback, parseListen } from './config'

describe('parseListen', () => {
  it.each([
    ['127.0.0.1:6767', { host: '127.0.0.1', port: 6767 }],
    ['0.0.0.0:9000', { host: '0.0.0.0', port: 9000 }],
    [':6767', { host: '127.0.0.1', port: 6767 }],
    ['6767', { host: '127.0.0.1', port: 6767 }],
    ['example.com', { host: 'example.com', port: 6767 }],
    ['  127.0.0.1:6767  ', { host: '127.0.0.1', port: 6767 }],
    ['127.0.0.1:abc', { host: '127.0.0.1', port: 6767 }],
  ])('%s', (input, want) => { expect(parseListen(input)).toEqual(want) })
})

describe('isLoopback', () => {
  // ★这条判断决定「要不要强制令牌」。判错的后果是一个**不需要任何凭据、能控制整台机器**的
  // 公网端口 —— 所以它必须宁可把回环误判成对外(多要个令牌,无害),也绝不能反过来。
  it.each(['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.0.0.5', ' 127.0.0.1 '])(
    '%s 算回环', (h) => { expect(isLoopback(h)).toBe(true) })

  it.each([
    '0.0.0.0', '', '192.168.1.10', '10.0.0.1', 'example.com', '::', '1.2.3.4',
    // ★这四个是真实的绕过手法。`startsWith('127.')` 会把前两个放过去。
    '127.0.0.1.evil.com', '127.0.0.1.nip.io', '1127.0.0.1', '127.0.0.999',
  ])(
    '%s 不算回环 —— 必须要令牌', (h) => { expect(isLoopback(h)).toBe(false) })
})

// runCli 的参数解析:第一版把 `--listen` 的**值**当成了命令名,真跑起来直接报
// 「不认识的命令: 127.0.0.1:6789」。这一组钉死那个形状。
import { parseArgs } from './args'
describe('CLI 参数', () => {
  it.each([
    [[], { cmd: 'start', listen: undefined }],
    [['--listen', '127.0.0.1:6789'], { cmd: 'start', listen: '127.0.0.1:6789' }],
    [['--listen=0.0.0.0:9000'], { cmd: 'start', listen: '0.0.0.0:9000' }],
    [['pair'], { cmd: 'pair', listen: undefined }],
    [['pair', '--listen', '0.0.0.0:9000'], { cmd: 'pair', listen: '0.0.0.0:9000' }],
    [['--listen', '127.0.0.1:1', 'status'], { cmd: 'status', listen: '127.0.0.1:1' }],
    [['daemon', 'status'], { cmd: 'status', listen: undefined }],
  ])('%j', (argv, want) => { expect(parseArgs(argv as string[])).toEqual(want) })
})
