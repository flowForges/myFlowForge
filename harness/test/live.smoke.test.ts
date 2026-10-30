import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROTOCOL_VERSION, connectClient, connectControlClient, runtimePaths, type KernelEvent, type MffaiClient } from '../src/protocol/index'

// 真实网络的手动冒烟:MFFAI_LIVE=1 且已 `npm run build`。数据目录是临时的,密钥明文存在其中,结束即删。
//   MFFAI_LIVE_PRESET=deepseek MFFAI_LIVE_KEY_FILE=~/key.txt [MFFAI_LIVE_MODEL=...]   API Key 账号
//   MFFAI_LIVE_CHATGPT=1 [MFFAI_LIVE_CHATGPT_MODEL=...]                                 ChatGPT 登录
const LIVE = process.env.MFFAI_LIVE === '1'
const DAEMON = resolve(__dirname, '../../out/main/mffaiDaemon.js')
const log = (s: string) => process.stderr.write(`[live] ${s}\n`)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe.skipIf(!LIVE)('live smoke', () => {
  let sup: ChildProcess | undefined
  const data = mkdtempSync(join(tmpdir(), 'mffai-live-'))
  afterAll(async () => {
    // 删目录前把守护进程日志里的 warn / error 打出来(日志不含密钥)
    try {
      const dir = runtimePaths(data).logs
      for (const f of readdirSync(dir)) for (const line of readFileSync(join(dir, f), 'utf8').split('\n'))
        if (/warn|error/i.test(line)) log(`${f}: ${line.slice(0, 600)}`)
    } catch { /* 无日志 */ }
    try {
      const c = await connectControlClient({ addr: runtimePaths(data).controlAddr, token: readFileSync(runtimePaths(data).token, 'utf8').trim() })
      await c.call('shutdown'); c.close()
      for (let i = 0; i < 100 && sup?.exitCode === null; i++) await sleep(100)
    } catch { /* 已退出 */ }
    try { if (sup?.pid) process.kill(-sup.pid, 'SIGKILL') } catch { /* 已退出 */ }
    await sleep(500)
    rmSync(data, { recursive: true, force: true, maxRetries: 5 })
  })

  async function start(): Promise<{ w: MffaiClient; events: KernelEvent[] }> {
    const electron = process.env.ELECTRON_BIN ?? (createRequire(import.meta.url)('electron') as string)
    sup = spawn(electron, [DAEMON], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MFFAI_DATA_DIR: data, MFFAI_AUTOSTART_DRY_RUN: '1', MFFAI_SECRETS_PLAINTEXT: '1' },
      stdio: 'ignore', detached: true,
    })
    const paths = runtimePaths(data)
    for (let i = 0; i < 200; i++) {
      try { readFileSync(paths.token); break } catch { await sleep(50) }
    }
    let w: MffaiClient | undefined
    for (let i = 0; i < 100 && !w; i++) {
      try { w = await connectClient({ addr: paths.workerAddr, token: readFileSync(paths.token, 'utf8').trim(), timeoutMs: 3000 }) } catch { await sleep(100) }
    }
    if (!w) throw new Error('daemon did not come up')
    expect((await w.call('hello', { clientVersion: 'live', protocolVersion: PROTOCOL_VERSION })).compatible).toBe(true)
    const events: KernelEvent[] = []
    w.onEvent(e => events.push(e))
    await w.call('events.subscribe', { after: 0 })
    return { w, events }
  }

  const waitEvent = async (events: KernelEvent[], pred: (e: KernelEvent) => boolean, ms: number, what: string) => {
    const end = Date.now() + ms
    while (Date.now() < end) { const e = events.find(pred); if (e) return e; await sleep(100) }
    throw new Error(`timeout: ${what}`)
  }

  async function chat(w: MffaiClient, events: KernelEvent[], accountId: string, modelId: string) {
    const t0 = Date.now()
    const { sessionId } = await w.call('session.create', { commandId: `c-${modelId}-${t0}`, model: { accountId, modelId } })
    await w.call('session.prompt', { commandId: `p-${t0}`, sessionId, text: '用一句话介绍你自己。' })
    const end = await waitEvent(events, e => e.sessionId === sessionId && (e.type === 'turn.ended' || e.type === 'turn.failed'), 120_000, 'turn end')
    const mine = events.filter(e => e.sessionId === sessionId)
    const deltas = mine.filter(e => e.type === 'message.assistant.delta').length
    const reasoning = mine.filter(e => e.type === 'message.reasoning.delta').length
    const usage = mine.find(e => e.type === 'turn.usage')?.payload
    const text = (mine.find(e => e.type === 'message.assistant')?.payload as { text?: string } | undefined)?.text
    log(`model=${modelId} result=${end.type} ${end.type === 'turn.failed' ? JSON.stringify(end.payload) : ''}`)
    log(`  text deltas=${deltas} reasoning deltas=${reasoning} usage=${JSON.stringify(usage)} ms=${Date.now() - t0}`)
    if (text) log(`  reply: ${text.slice(0, 200)}`)
    return end.type
  }

  it('API key account', async () => {
    const preset = process.env.MFFAI_LIVE_PRESET
    const keyFile = process.env.MFFAI_LIVE_KEY_FILE?.replace(/^~/, process.env.HOME ?? '')
    if (!preset || !keyFile) return log('skip API key (set MFFAI_LIVE_PRESET + MFFAI_LIVE_KEY_FILE)')
    const { w, events } = await start()
    const apiKey = readFileSync(keyFile, 'utf8').trim()
    const a = await w.call('models.addAccount', { commandId: 'add-key', presetId: preset, apiKey, restrictionAck: true })
    log(`account ${a.presetId} state=${a.state}`)
    const t = await w.call('models.testAccount', { accountId: a.id })
    log(`test ok=${t.ok} ${t.error ? JSON.stringify(t.error) : ''}`)
    const cat = await w.call('models.catalog')
    await sleep(1500) // 列表类预设:等模型清单拉取
    const acc = (await w.call('models.accounts')).accounts.find(x => x.id === a.id)!
    const list = (cat.models[preset]?.length ? cat.models[preset] : acc.models) ?? []
    log(`models (${list.length}): ${list.slice(0, 12).map(m => m.id).join(', ')}`)
    const modelId = process.env.MFFAI_LIVE_MODEL ?? list[0]?.id
    expect(modelId).toBeTruthy()
    log(`quota: ${JSON.stringify(await w.call('models.quota', { accountId: a.id }))}`)
    expect(await chat(w, events, a.id, modelId!)).toBe('turn.ended')
    w.close()
  }, 300_000)

  it('ChatGPT sign-in', async () => {
    if (process.env.MFFAI_LIVE_CHATGPT !== '1') return log('skip ChatGPT (set MFFAI_LIVE_CHATGPT=1)')
    const { w, events } = sup ? { w: await connectClient({ addr: runtimePaths(data).workerAddr, token: readFileSync(runtimePaths(data).token, 'utf8').trim() }), events: [] as KernelEvent[] } : await start()
    if (!events.length) { w.onEvent(e => events.push(e)); await w.call('events.subscribe', { after: 0 }) }
    const { flowId, authUrl } = await w.call('auth.chatgpt.begin', {})
    log(`opening browser: ${authUrl}`)
    try { execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [authUrl]) } catch { log('open it manually') }
    const ended = await waitEvent(events, e => e.type === 'auth.chatgpt.ended' && (e.payload as { flowId: string }).flowId === flowId, 600_000, 'login')
    log(`login ended: ${JSON.stringify(ended.payload)}`)
    const accountId = (ended.payload as { ok: boolean; accountId?: string }).accountId
    expect((ended.payload as { ok: boolean }).ok).toBe(true)
    let acc
    for (let i = 0; i < 60; i++) {
      acc = (await w.call('models.accounts')).accounts.find(x => x.id === accountId)
      if (acc?.models?.length) break
      await sleep(500)
    }
    log(`account state=${acc?.state} models (${acc?.models?.length ?? 0}): ${(acc?.models ?? []).map(m => m.id).join(', ')}`)
    log(`quota: ${JSON.stringify(await w.call('models.quota', { accountId: accountId! }))}`)
    const modelId = process.env.MFFAI_LIVE_CHATGPT_MODEL ?? acc?.models?.find(m => m.id.startsWith('gpt-5'))?.id ?? acc?.models?.[0]?.id
    expect(modelId).toBeTruthy()
    expect(await chat(w, events, accountId!, modelId!)).toBe('turn.ended')
    await w.call('models.removeAccount', { commandId: 'rm-chatgpt', accountId: accountId! }) // 撤销 refresh token
    w.close()
  }, 900_000)
})
