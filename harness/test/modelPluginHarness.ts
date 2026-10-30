// 模型协议插件测试夹具:node:http 假服务 + 收集适配器的假 models 服务
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKernel, type Kernel } from '../src/kernel/kernel'
import type { Plugin } from '../src/kernel/pluginHost'
import type { Account, ModelAdapter, ModelEvent, ModelProtocol, ModelRequest } from '../src/lib/models/types'

export const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/sse', name), 'utf8')

export interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
export type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void

export async function fakeServer(handler: Handler): Promise<{ server: Server; base: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      handler(req, res, s)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

export const sse = (res: ServerResponse, text: string) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(text)
}

export async function bootAdapters(plugin: Plugin) {
  const dir = mkdtempSync(join(tmpdir(), 'mffai-modelplug-'))
  const adapters = new Map<ModelProtocol, ModelAdapter>()
  const models: Plugin = {
    manifest: { id: 'models-registry', version: '1', kernel: '*', provides: ['models'] },
    activate(ctx) {
      ctx.services.provide('models', {
        registerAdapter(p: ModelProtocol, a: ModelAdapter) { adapters.set(p, a); return () => { adapters.delete(p) } },
      })
    },
  }
  const k: Kernel = await createKernel({ dataDir: dir, plugins: [models, plugin], secrets: { osBackend: false } })
  return {
    adapters,
    async close() { await k.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }) },
  }
}

export const account = (protocol: ModelProtocol, baseUrl: string, extra: Partial<Account> = {}): Account => ({
  id: 'a1', presetId: 'p', label: 'l', protocol, baseUrl, apiKey: 'sk-test', state: 'ok', ...extra,
})

export const request = (signal: AbortSignal = new AbortController().signal, extra: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'm1', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], interactive: true, signal, ...extra,
})

export async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

export const text = (evs: ModelEvent[]) => evs.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
