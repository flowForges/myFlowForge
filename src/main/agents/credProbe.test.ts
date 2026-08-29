import { describe, it, expect, vi } from 'vitest'
import { probeAuth, PROBES, stripAnsi } from './credProbe'

const run = (out: string) => vi.fn(async () => out)

describe('probeAuth · 三态', () => {
  it('★没有探测方案的 provider 一律 unknown —— 不知道就闭嘴,别说成没登录', async () => {
    expect(await probeAuth('gemini', 'gemini', {})).toBe('unknown')
    expect(await probeAuth('qwen', 'qwen', {})).toBe('unknown')
    expect(await probeAuth('qoder', 'qoder', {})).toBe('unknown')
    expect(await probeAuth('随便编一个', 'x', {})).toBe('unknown')
  })

  it('没有 bin 时不去跑任何东西', async () => {
    const r = run('whatever')
    expect(await probeAuth('claude', undefined, {}, { run: r })).toBe('unknown')
    expect(r).not.toHaveBeenCalled()
  })

  it('★环境变量里有 key 就算登录,而且**根本不跑 CLI**', async () => {
    const r = run('')
    expect(await probeAuth('claude', 'claude', { ANTHROPIC_API_KEY: 'sk-x' }, { run: r })).toBe('ok')
    expect(await probeAuth('codex', 'codex', { OPENAI_API_KEY: 'sk-x' }, { run: r })).toBe('ok')
    expect(await probeAuth('cursor', 'cursor-agent', { CURSOR_API_KEY: 'k' }, { run: r })).toBe('ok')
    expect(r).not.toHaveBeenCalled()
  })

  it('空白的环境变量不算', async () => {
    const r = run('{"loggedIn":false}')
    expect(await probeAuth('claude', 'claude', { ANTHROPIC_API_KEY: '   ' }, { run: r })).toBe('missing')
  })

  it('★copilot 只认环境变量 —— 它没有 status 子命令,令牌在钥匙串里', async () => {
    expect(await probeAuth('copilot', 'copilot', { GH_TOKEN: 't' })).toBe('ok')
    // 拿不到就是 unknown,不是 missing:钥匙串里可能好好地存着。
    expect(await probeAuth('copilot', 'copilot', {})).toBe('unknown')
  })

  it('探测抛异常 / 超时 → unknown,不是 missing', async () => {
    const r = vi.fn(async () => { throw new Error('ETIMEDOUT') })
    expect(await probeAuth('claude', 'claude', {}, { run: r })).toBe('unknown')
  })
})

describe('claude · auth status 回 JSON', () => {
  const p = (out: string) => PROBES.claude!.parse(out)

  it('实测那段输出', () => {
    expect(p('{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "subscriptionType": "max"\n}')).toBe('ok')
  })

  it('★用户 shell 里套着 wrapper 时,JSON 前面会有别的输出', () => {
    // 本机 `claude` 前面就有一层会打印这几行的代理检查器。假设 stdout 干净 = 永远 unknown。
    const noisy = '启动 Claude...\n正在检查...\n当前: 45.203.61.192\n{"loggedIn": true}'
    expect(p(noisy)).toBe('ok')
  })

  it('没登录', () => {
    expect(p('{"loggedIn": false}')).toBe('missing')
  })

  it('形状不对 / 不是 JSON → unknown', () => {
    expect(p('command not found')).toBe('unknown')
    expect(p('{"loggedIn": "yes"}')).toBe('unknown')
    expect(p('{ 半个 json')).toBe('unknown')
    expect(p('[1,2,3]')).toBe('unknown')
    expect(p('')).toBe('unknown')
  })
})

describe('codex / cursor · 回一行人话', () => {
  it('★「Not logged in」里含着「logged in」—— 否定必须先判,否则永远报已登录', () => {
    expect(PROBES.cursor!.parse('Not logged in')).toBe('missing')
    expect(PROBES.codex!.parse('Not logged in')).toBe('missing')
  })

  it('实测的肯定输出', () => {
    expect(PROBES.codex!.parse('Logged in using ChatGPT')).toBe('ok')
  })

  it('大小写和中文都认', () => {
    expect(PROBES.codex!.parse('LOGGED IN')).toBe('ok')
    expect(PROBES.cursor!.parse('未登录')).toBe('missing')
    expect(PROBES.cursor!.parse('已登录')).toBe('ok')
  })

  it('认不出来的输出 → unknown', () => {
    expect(PROBES.codex!.parse('usage: codex login [options]')).toBe('unknown')
    expect(PROBES.cursor!.parse('')).toBe('unknown')
  })
})

describe('opencode · 数凭据条数', () => {
  const p = (out: string) => PROBES.opencode!.parse(out)

  it('★实测输出带 ANSI 颜色码,不剥就对不上', () => {
    const esc = String.fromCharCode(27)
    expect(p(`${esc}[0m\n┌  Credentials\n│\n└  0 credentials\n`)).toBe('missing')
    expect(p(`${esc}[0m└  ${esc}[90m3 credentials`)).toBe('ok')
  })

  it('数不出来 → unknown', () => {
    expect(p('command not found')).toBe('unknown')
  })
})

describe('stripAnsi', () => {
  it('剥掉颜色码,别的一个字不动', () => {
    const esc = String.fromCharCode(27)
    expect(stripAnsi(`${esc}[90m你好${esc}[0m`)).toBe('你好')
    expect(stripAnsi('没有颜色码')).toBe('没有颜色码')
  })
})
