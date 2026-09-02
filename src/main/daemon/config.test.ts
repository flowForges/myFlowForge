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
  const base = { listen: undefined, address: undefined, relay: undefined }
  it.each([
    [[], { cmd: 'start', ...base }],
    [['--listen', '127.0.0.1:6789'], { cmd: 'start', ...base, listen: '127.0.0.1:6789' }],
    [['--listen=0.0.0.0:9000'], { cmd: 'start', ...base, listen: '0.0.0.0:9000' }],
    [['pair'], { cmd: 'pair', ...base }],
    [['pair', '--listen', '0.0.0.0:9000'], { cmd: 'pair', ...base, listen: '0.0.0.0:9000' }],
    [['--listen', '127.0.0.1:1', 'status'], { cmd: 'status', ...base, listen: '127.0.0.1:1' }],
    [['daemon', 'status'], { cmd: 'status', ...base }],
    // ★云服务器:网卡上是内网地址,配对码里要印的是公网那个
    [['pair', '--address', '1.2.3.4:6767'], { cmd: 'pair', ...base, address: '1.2.3.4:6767' }],
    [['--relay=wss://r.example/', '--listen', '127.0.0.1:6767'],
      { cmd: 'start', ...base, listen: '127.0.0.1:6767', relay: 'wss://r.example/' }],
    // ★★两个带值选项挨着写时,后一个的**值**不能被当成命令名(第一版就栽在这条上)
    [['--listen', '0.0.0.0:1', '--address', '5.6.7.8:1', 'pair'],
      { cmd: 'pair', ...base, listen: '0.0.0.0:1', address: '5.6.7.8:1' }],
  ])('%j', (argv, want) => { expect(parseArgs(argv as string[])).toEqual(want) })
})
