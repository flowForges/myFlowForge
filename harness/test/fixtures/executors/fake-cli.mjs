#!/usr/bin/env node
// 假的编码 CLI(04 spec §2 的行为)。复制到临时 bin 目录,改名 codex / qodercli;
// 剧本读 <bin 目录>/scenario.json(不走环境变量:环境白名单会丢掉 FAKE_*)。
// 每次调用往 calls.jsonl 追加 {argv, stdin, envNames, env, cwd};起的每个进程往 pids.jsonl 追加 {role, pid, start}。
//
// 剧本字段:
//   version、loginStatus(原样打印)、loginExit、probeSleep(ms,探测命令先等这么久)
//   selftest: 'pass' | 'fail:<row>'(`sandbox …` 每行打印 `<row> r=<n>`,不做真实操作,也不连网)
//   writeFiles {相对 cwd 的路径: 内容}、deleteFiles [路径]
//   lines [字符串 | {line, delayMs}]、flood(行数)、stderr(字符串 | 字符串数组)、sleep(ms)、exit(退出码)
//   forwarding:起一个自成一会话的 sleep 300。SIGINT → 杀掉它再退;SIGTERM → 只有自己退,它活下来(实测的 Codex)
//   stubborn:忽略 SIGINT / SIGTERM,再起一个同样忽略两者、自成一会话的孙进程
//   grandchild:只起那个孙进程,自己不忽略信号(SIGINT 一到就死,ppid 链随之断开,像 node 包装层)
//   escape:起一个 ppid 已是 1、自成一会话、拿着 stdout 的 sleep(进程树找不到它)
//   background:起一个同组、不碰 stdio 的 sleep
// forwarding / stubborn 跑完前面的步骤后一直活着,等信号。
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const BIN = dirname(process.argv[1])
const argv = process.argv.slice(2)
const pause = ms => new Promise(res => setTimeout(res, ms))
const forever = () => setInterval(() => {}, 1000)
const ignore = sig => process.on(sig, () => {})

/** 沙箱里写不了 bin 目录时不算错 */
const record = (file, value) => {
  try {
    appendFileSync(join(BIN, file), JSON.stringify(value) + '\n')
  } catch {
    // 只影响测试断言
  }
}

/** 与 lib/proc/pgids.ts 的 startTime 同格式:测试清理时靠它确认 pid 还是这个进程 */
function startOf(pid) {
  try {
    if (process.platform === 'linux') {
      const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return s.slice(s.lastIndexOf(')') + 2).trim().split(' ')[19]
    }
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || undefined
  } catch {
    return undefined
  }
}
const logPid = (role, pid = process.pid) => record('pids.jsonl', { role, pid, start: startOf(pid) })

const self = (role, opts) => spawn(process.execPath, [process.argv[1], `--fake-role=${role}`], { detached: true, ...opts })

async function readStdin() {
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

function loadScenario() {
  const f = join(BIN, 'scenario.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
}

function write(stream, text) {
  return new Promise(res => stream.write(text, () => res()))
}

const SELFTEST_ROWS = { secret_read: 1, cwd_write: 0, outside_write: 1, git_write: 1, tmp_write: 0, net_connect: 1 }

function selfTestOutput(selftest = 'pass') {
  const failed = selftest.startsWith('fail:') ? selftest.slice('fail:'.length) : undefined
  return Object.entries(SELFTEST_ROWS)
    .map(([row, r]) => `${row} r=${row === failed ? 1 - r : r}\n`)
    .join('')
}

async function main() {
  const sc = loadScenario()
  const pick = keys => Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
  const call = stdin =>
    record('calls.jsonl', {
      argv,
      stdin,
      envNames: Object.keys(process.env).sort(),
      env: pick(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'TMPDIR', 'CODEX_HOME']),
      cwd: process.cwd(),
    })

  const answer = async (text, code = 0) => {
    call('')
    if (sc.probeSleep) await pause(sc.probeSleep)
    await write(process.stdout, text)
    process.exit(code)
  }
  if (argv[0] === '--version') return answer(`${sc.version ?? 'fake-cli 0.0.0'}\n`)
  if (argv[0] === 'login' && argv[1] === 'status') return answer(`${sc.loginStatus ?? 'Logged in using ChatGPT'}\n`, sc.loginExit ?? 0)
  if (argv[0] === 'status') return answer(`${sc.loginStatus ?? '{"logged_in":true}'}\n`, sc.loginExit ?? 0)
  if (argv[0] === 'sandbox') return answer(selfTestOutput(sc.selftest))

  // 先装好信号处理再记 pid:测试看到 pid 时行为已经就位
  if (sc.stubborn) {
    ignore('SIGINT')
    ignore('SIGTERM')
  }
  let sleeper
  if (sc.forwarding) {
    process.on('SIGINT', () => {
      sleeper?.kill('SIGKILL')
      process.exit(130)
    })
    process.on('SIGTERM', () => process.exit(143))
  }
  logPid('cli')

  if (sc.forwarding) {
    sleeper = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' })
    sleeper.unref()
    logPid('child', sleeper.pid)
  }
  if (sc.stubborn || sc.grandchild) self('grandchild', { stdio: 'ignore' }).unref()
  if (sc.escape) self('escaper', { stdio: ['ignore', 'inherit', 'inherit'] }).unref()
  if (sc.background) {
    const bg = spawn('/bin/sleep', ['300'], { stdio: 'ignore' })
    bg.unref()
    logPid('background', bg.pid)
  }

  call(await readStdin())

  for (const [rel, content] of Object.entries(sc.writeFiles ?? {})) {
    mkdirSync(dirname(rel), { recursive: true })
    writeFileSync(rel, content)
  }
  for (const rel of sc.deleteFiles ?? []) rmSync(rel, { force: true })

  for (const item of sc.lines ?? []) {
    const { line, delayMs } = typeof item === 'string' ? { line: item } : item
    if (delayMs) await pause(delayMs)
    await write(process.stdout, line + '\n')
  }
  for (let i = 0; i < (sc.flood ?? 0); i++) await write(process.stdout, `{"flood":${i}}\n`)
  for (const line of [sc.stderr ?? []].flat()) await write(process.stderr, line + '\n')

  if (sc.sleep) await pause(sc.sleep)
  if (sc.forwarding || sc.stubborn) return void forever()
  process.exit(sc.exit ?? 0)
}

// 内部角色:不算一次 CLI 调用
const role = argv[0]?.startsWith('--fake-role=') ? argv[0].slice('--fake-role='.length) : undefined
if (role === 'grandchild') {
  ignore('SIGINT')
  ignore('SIGTERM')
  logPid('grandchild')
  forever()
} else if (role === 'escaper') {
  // 中间一层:拉起 escaped 就退,escaped 的 ppid 变成 1
  self('escaped', { stdio: 'inherit' }).unref()
  process.exit(0)
} else if (role === 'escaped') {
  logPid('escaped')
  forever()
} else {
  await main()
}
