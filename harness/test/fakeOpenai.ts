import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// e2e 用的假 OpenAI 兼容服务:127.0.0.1 随机端口,GET /models 列一个模型,POST /chat/completions 按请求序号回脚本化的 SSE。
//   第 1 次 → read hello.txt;第 2 次 → edit world → mff;之后 → 文本 done

export interface FakeOpenaiRequest { method: string; url: string; authorization?: string; body: string }
export interface FakeOpenai { base: string; requests: FakeOpenaiRequest[]; close: () => Promise<void> }

export const FAKE_MODEL = 'fake-coder'

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: FAKE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const usage = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
const DONE = 'data: [DONE]\n\n'

function toolCall(id: string, name: string, args: Record<string, unknown>): string {
  return chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] })
    + chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })
    + chunk({}, 'tool_calls') + usage + DONE
}

const SCRIPT = [
  () => toolCall('call_read', 'read', { path: 'hello.txt' }),
  () => toolCall('call_edit', 'edit', { path: 'hello.txt', old: 'world', new: 'mff' }),
]
const finalText = () => chunk({ role: 'assistant', content: 'done' }) + chunk({}, 'stop') + usage + DONE

const bodyOf = (req: IncomingMessage) => new Promise<string>((resolve) => {
  const parts: Buffer[] = []
  req.on('data', (c: Buffer) => parts.push(c))
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
})

export async function startFakeOpenai(): Promise<FakeOpenai> {
  const requests: FakeOpenaiRequest[] = []
  let chats = 0
  const server: Server = createServer((req, res) => {
    void bodyOf(req).then((body) => {
      const url = (req.url ?? '').replace(/\?.*$/, '')
      requests.push({ method: req.method ?? '', url, authorization: req.headers.authorization, body })
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model', owned_by: 'fake' }] }))
      }
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        const step = SCRIPT[chats++] ?? finalText
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        return res.end(step())
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"not found"}}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())) },
  }
}
