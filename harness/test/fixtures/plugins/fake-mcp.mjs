#!/usr/bin/env node
// 假的 MCP 服务(09)。按行收发 JSON-RPC;只用 Node 内置模块。
// 剧本读自身旁边的 scenario.json(不走环境变量:环境正是被测的东西)。
// 每条收到的消息往旁边的 calls.jsonl 追加 {method, params, argv, envNames, cwd};沙箱里写不了就写 $HOME/calls.jsonl。
// 不打印环境的值;值只有 probe_env 被调用时才给。
//
// 剧本字段:
//   neverInit:读 initialize,永远不答
//   crashOnCall:收到 tools/call 就以这个退出码退出(true = 1)
//   garbage:每次答之前先打一行这个(true = 一行固定的非 JSON)
//   unknownId:答完 initialize 再答一个没人问过的 id
//   hugeLine:tools/list 不答,打一行这么多字节
//   toolCount:再加这么多个 tool_<n>;pageSize:tools/list 每页这么多个,用 nextCursor 翻页
//   badNames:工具名单里再加这些名字(true = 一组固定的坏名字)
//   serverRequests:[方法名 | {method, params}],收到 notifications/initialized 后发给客户端;答复记成 method: 'response'
//   stderr:启动时写到 stderr(字符串 | 字符串数组)
//   instructions:initialize 结果里带上它
//   delayMs:每个答复晚这么久;其间收到 notifications/cancelled 就不答了
//   callDelayMs:只有 tools/call 的答复晚这么久,握手和列表照常
//   listChangedAfter:第 n 次 tools/call 之后发 notifications/tools/list_changed,工具说明从此变样
//   stubborn:不理 stdin 关闭和 SIGTERM,只有 SIGKILL 收得掉
// 工具:echo(参数原样回)、probe_read、probe_write、probe_fetch、probe_env、probe_children,都回真实发生的事。
// probe_children 的 survivor:{trigger, out, pidFile, host, port}:两次 fork、自成一会话的孙进程,等 trigger 出现后经环境里的代理 CONNECT,
// 结果写到 out。它拿着的是启动它的那次服务的环境(代理凭据也是那次的)
// stdin 关了就退(和真的服务一样),除此之外自己不退;测试崩了也留不下进程,到点自己走。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

const DIR = dirname(process.argv[1])
const ARGV = process.argv.slice(2)
const SURVIVOR = ARGV[0] === '--survivor' || ARGV[0] === '--survivor-inner'
const SAFETY_EXIT_MS = 300_000
const BAD_NAMES = ['a;rm -rf', '../x', 'has space', '']
const scenario = (() => {
  const f = join(DIR, 'scenario.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
})()

function record(method, params) {
  const line = `${JSON.stringify({ method, params, argv: ARGV, envNames: Object.keys(process.env).sort(), cwd: process.cwd() })}\n`
  for (const target of [join(DIR, 'calls.jsonl'), process.env.HOME && join(process.env.HOME, 'calls.jsonl')]) {
    if (!target) continue
    try {
      appendFileSync(target, line)
      return
    } catch {
      // 只影响测试断言:沙箱里可能哪都写不了
    }
  }
}

const write = obj => process.stdout.write(`${JSON.stringify(obj)}\n`)
const pending = new Map()
const cancelled = new Set()
let callsSeen = 0
let descriptionsMoved = false
let nextServerId = 1000

function answer(id, body, ms = scenario.delayMs) {
  const send = () => {
    pending.delete(id)
    if (cancelled.has(id)) return
    if (scenario.garbage) process.stdout.write(`${scenario.garbage === true ? '<<<not json>>>' : scenario.garbage}\n`)
    write({ jsonrpc: '2.0', id, ...body })
  }
  if (ms) pending.set(id, setTimeout(send, ms))
  else send()
}
const ok = (id, result, ms) => answer(id, { result }, ms)
const fail = (id, code, message) => answer(id, { error: { code, message } })

const obj = { type: 'object', properties: {} }
const BUILT_IN = {
  echo: 'Returns its arguments.',
  probe_children: 'Reports this process, its children, and optionally starts one.',
  probe_env: 'Reports the environment and the working directory.',
  probe_fetch: 'Connects to a host through the proxy in the environment, or directly.',
  probe_read: 'Reads a file.',
  probe_write: 'Writes a file.',
}

function toolList() {
  const tools = Object.entries(BUILT_IN).map(([name, description]) => ({ name, description, inputSchema: obj }))
  for (let i = 0; i < (scenario.toolCount ?? 0); i++) tools.push({ name: `tool_${i}`, description: `Tool ${i}.`, inputSchema: obj })
  const bad = scenario.badNames === true ? BAD_NAMES : (scenario.badNames ?? [])
  for (const name of bad) tools.push({ name, description: 'Oddly named.', inputSchema: obj })
  if (descriptionsMoved) for (const t of tools) t.description = `${t.description} (changed)`
  return tools
}

function listTools(id, params) {
  if (scenario.hugeLine) {
    process.stdout.write(`${'x'.repeat(scenario.hugeLine)}\n`)
    return
  }
  const tools = toolList()
  const size = scenario.pageSize
  if (!size) return ok(id, { tools })
  const from = Number(params?.cursor ?? 0)
  const page = tools.slice(from, from + size)
  ok(id, { tools: page, ...(from + size < tools.length && { nextCursor: String(from + size) }) })
}

const errCode = e => e?.code ?? String(e?.message ?? e)

function probeRead(a) {
  try {
    const text = readFileSync(a.path, 'utf8')
    return { ok: true, bytes: Buffer.byteLength(text), text: text.slice(0, 4096) }
  } catch (e) {
    return { ok: false, code: errCode(e) }
  }
}

function probeWrite(a) {
  // afterMs:先答,过一会儿才写。轮结束之后还想动 cwd 的服务就长这样
  if (a.afterMs) {
    setTimeout(() => {
      try {
        writeFileSync(a.path, a.text ?? '')
      } catch {
        // 只有文件在不在是断言
      }
    }, a.afterMs)
    return { ok: true, later: true }
  }
  try {
    writeFileSync(a.path, a.text ?? '')
    return { ok: true }
  } catch (e) {
    return { ok: false, code: errCode(e) }
  }
}

/** 沙箱里的 ps 可能什么都看不到:ps 字段如实说 */
function probeChildren(a) {
  const out = { self: { pid: process.pid, argv: process.argv, execArgv: process.execArgv }, children: [], ps: 'ok' }
  if (a.spawn) {
    const c = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' })
    c.unref()
    out.spawned = c.pid
  }
  if (a.survivor) {
    spawn(process.execPath, [process.argv[1], '--survivor', JSON.stringify(a.survivor)], { detached: true, stdio: 'ignore' }).unref()
    out.survivor = 'started'
  }
  if (a.exec) {
    const x = spawnSync(a.exec[0], a.exec.slice(1), { encoding: 'utf8', timeout: a.timeoutMs ?? 30_000 })
    out.exec = { status: x.status, stdout: x.stdout ?? '', stderr: (x.stderr ?? '').slice(0, 2000), error: x.error ? errCode(x.error) : undefined }
    return out
  }
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  if (r.status !== 0) out.ps = `failed: ${r.status ?? errCode(r.error)}`
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m && Number(m[2]) === process.pid && Number(m[1]) !== r.pid) out.children.push({ pid: Number(m[1]), args: m[3] })
  }
  return out
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
/** direct:直接连 host:port。否则走环境里的代理:发 CONNECT,回代理的状态码 */
function probeFetch(a) {
  const proxyUrl = a.direct ? undefined : PROXY_VARS.map(n => process.env[n]).find(Boolean)
  const port = Number(a.port ?? 443)
  return new Promise(resolve => {
    const finish = r => {
      s.destroy()
      resolve(r)
    }
    let s
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout', via: proxyUrl ? 'proxy' : 'direct' }), a.timeoutMs ?? 5000)
    const end = r => {
      clearTimeout(timer)
      finish(r)
    }
    if (proxyUrl) {
      const u = new URL(proxyUrl)
      // 和 curl、git、pip 一样:URL 里有 userinfo 就主动发 Basic
      const auth = u.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n` : ''
      s = connect({ host: u.hostname, port: Number(u.port) }, () => s.write(`CONNECT ${a.host}:${port} HTTP/1.1\r\nHost: ${a.host}:${port}\r\n${auth}\r\n`))
      let buf = ''
      s.on('data', d => {
        buf += d
        const eol = buf.indexOf('\r\n')
        if (eol < 0) return
        const status = Number(buf.slice(0, eol).split(' ')[1])
        end({ ok: status >= 200 && status < 300, status, via: 'proxy' })
      })
    } else {
      s = connect({ host: a.host, port }, () => end({ ok: true, via: 'direct' }))
    }
    s.on('error', e => end({ ok: false, code: errCode(e), via: proxyUrl ? 'proxy' : 'direct' }))
  })
}

async function runTool(name, a) {
  switch (name) {
    case 'echo':
      return a
    case 'probe_read':
      return probeRead(a)
    case 'probe_write':
      return probeWrite(a)
    case 'probe_env':
      return { env: process.env, cwd: process.cwd(), argv: process.argv, ...(a.same && { same: Object.fromEntries(Object.entries(a.same).map(([k, v]) => [k, process.env[k] === v])) }), ...(a.cwdIs && { cwdIs: process.cwd() === a.cwdIs }) }
    case 'probe_children':
      return probeChildren(a)
    case 'probe_fetch':
      return probeFetch(a)
    default:
      return { name, a }
  }
}

async function callTool(id, params) {
  if (scenario.crashOnCall) process.exit(scenario.crashOnCall === true ? 1 : scenario.crashOnCall)
  callsSeen++
  const name = params?.name
  if (!toolList().some(t => t.name === name)) return fail(id, -32602, `unknown tool: ${name}`)
  const result = await runTool(name, params?.arguments ?? {})
  ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }] }, scenario.callDelayMs ?? scenario.delayMs)
  if (scenario.listChangedAfter && callsSeen === scenario.listChangedAfter) {
    descriptionsMoved = true
    write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }
}

function sendServerRequests() {
  for (const r of scenario.serverRequests ?? []) {
    const { method, params } = typeof r === 'string' ? { method: r } : r
    write({ jsonrpc: '2.0', id: nextServerId++, method, ...(params && { params }) })
  }
}

function onMessage(m) {
  if (m.method === undefined) {
    record('response', m)
    return
  }
  record(m.method, m.params)
  const { id, method, params } = m
  switch (method) {
    case 'initialize':
      if (scenario.neverInit) return
      ok(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '0' },
        ...(scenario.instructions !== undefined && { instructions: scenario.instructions }),
      })
      if (scenario.unknownId) write({ jsonrpc: '2.0', id: 987654, result: {} })
      return
    case 'notifications/initialized':
      sendServerRequests()
      return
    case 'notifications/cancelled':
      // 同一块 stdin 里来的取消排在工具的 await 之前,所以记下 id,不只是清定时器
      cancelled.add(params?.requestId)
      clearTimeout(pending.get(params?.requestId))
      pending.delete(params?.requestId)
      return
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return listTools(id, params)
    case 'tools/call':
      return void callTool(id, params)
    default:
      if (id !== undefined) fail(id, -32601, `method not found: ${method}`)
  }
}

function survive() {
  const o = JSON.parse(ARGV[1])
  // 第一层只再起一层就走:孙进程的父进程没了,ppid 和进程组都认不回服务
  if (ARGV[0] === '--survivor') {
    spawn(process.execPath, [process.argv[1], '--survivor-inner', ARGV[1]], { detached: true, stdio: 'ignore' }).unref()
    return process.exit(0)
  }
  writeFileSync(o.pidFile, String(process.pid))
  setTimeout(() => process.exit(0), 120_000)
  const poll = setInterval(async () => {
    if (!existsSync(o.trigger)) return
    clearInterval(poll)
    writeFileSync(o.out, JSON.stringify(await probeFetch({ host: o.host, port: o.port, timeoutMs: 5000 })))
    process.exit(0)
  }, 50)
}

if (SURVIVOR) survive()
else {
for (const line of [scenario.stderr ?? []].flat()) process.stderr.write(`${line}\n`)
if (scenario.stubborn) process.on('SIGTERM', () => {})

// 自己不退;这个定时器让事件循环一直活着,到点是给崩掉的测试兜底
setTimeout(() => process.exit(0), SAFETY_EXIT_MS)

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => {
  buf += d
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      onMessage(JSON.parse(line))
    } catch {
      // 客户端的坏行不归这里管
    }
  }
})
process.stdin.on('end', () => {
  if (!scenario.stubborn) process.exit(0)
})
}
