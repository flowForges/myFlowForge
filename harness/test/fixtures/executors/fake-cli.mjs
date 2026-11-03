#!/usr/bin/env node
// 假的编码 CLI(04 spec §2 的行为)。复制到临时 bin 目录,改名 codex / qodercli;
// 剧本读 <bin 目录>/scenario.json(不走环境变量:环境白名单会丢掉 FAKE_*)。
// 每次调用往 calls.jsonl 追加 {argv, stdin, envNames, env, cwd};起的每个进程往 pids.jsonl 追加 {role, pid, start}。
//
// 剧本字段:
//   version、loginStatus(原样打印)、loginExit、probeSleep(ms,探测命令先等这么久)
//   selftest: 'pass' | 'fail:<row>' | 'omit:<row>'(`sandbox …` 每行打印 `<row> r=<n>`,不做真实操作,也不连网)
//             'run':真的跑 `--` 后面的命令(cwd 取 -C),不加任何隔离,用来验自检脚本本身
//   selftestExit(`sandbox` 的退出码)、selftestConnect(打印之前连一次最后一个参数给的本机端口,行照样报 r=1)
//   writeFiles {相对 cwd 的路径: 内容}、deleteFiles [路径]
//   run:用 /bin/sh -c 跑这段脚本,把读到的 stdin 交给它,输出直通,脚本的退出码就是假 CLI 的退出码(验沙箱里 CLI 能做什么)
//   lines [字符串 | {line, delayMs}]、flood(行数)、stderr(字符串 | 字符串数组)、sleep(ms)、exit(退出码)
//   floodLine:flood 每行的内容,`#` 换成序号;bigLine {bytes, text}:一行 bytes 字节的 x,开头是 text
//   forwarding:起一个自成一会话的 sleep 300。SIGINT → 杀掉它再退;SIGTERM → 只有自己退,它活下来(实测的 Codex)
//   stubborn:忽略 SIGINT / SIGTERM,再起一个同样忽略两者、自成一会话的孙进程
//   grandchild:只起那个孙进程,自己不忽略信号(SIGINT 一到就死,ppid 链随之断开,像 node 包装层)
//   escape:起一个 ppid 已是 1、自成一会话、拿着 stdout 的 sleep(进程树找不到它)
//   background:起一个同组、不碰 stdio 的 sleep
// forwarding / stubborn 跑完前面的步骤后一直活着,等信号。
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

const BIN = dirname(process.argv[1])
const argv = process.argv.slice(2)
const pause = ms => new Promise(res => setTimeout(res, ms))
/** 等信号。到点自己退:测试崩了也不会留下永远不死的进程 */
const forever = () => {
  setInterval(() => {}, 1000)
  setTimeout(() => process.exit(0), 120_000).unref()
}
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

const SELFTEST_ROWS = { secret_read: 1, cwd_write: 0, outside_write: 1, git_write: 1, nested_git_hook: 1, nested_git_config: 1, codex_config_write: 1, qoder_config_write: 1, tmp_write: 0, rule_write: 1, rule_read: 1, secret_dir_read: 1, net_connect: 1 }
/** 权限档里没有 :project_roots = 只读那一遍 */
const READ_ONLY_ROWS = { ro_cwd_write: 1, ro_cwd_read: 0 }
/** 从仓库子目录跑的那一遍:-C 指向 …/sub */
const SUBDIR_ROWS = { sub_cwd_write: 0, parent_write: 1, sibling_write: 1 }
const isSubdirPass = () => argv[argv.indexOf('-C') + 1]?.endsWith('/sub')
const isReadOnlyPass = () => argv.some(a => a.startsWith('permissions.mffai.filesystem=') && !a.includes(':project_roots'))

function selfTestOutput(selftest = 'pass') {
  const failed = selftest.startsWith('fail:') ? selftest.slice('fail:'.length) : undefined
  const omitted = selftest.startsWith('omit:') ? selftest.slice('omit:'.length) : undefined
  return Object.entries(isReadOnlyPass() ? READ_ONLY_ROWS : isSubdirPass() ? SUBDIR_ROWS : SELFTEST_ROWS)
    .filter(([row]) => row !== omitted)
    .map(([row, r]) => `${row} r=${row === failed ? 1 - r : r}\n`)
    .join('')
}

const connectOnce = port =>
  new Promise(res => {
    const c = connect(port, '127.0.0.1', () => {
      c.destroy()
      res()
    })
    c.on('error', () => res())
  })

function runCommand() {
  const command = argv.slice(argv.indexOf('--') + 1)
  const r = spawnSync(command[0], command.slice(1), { cwd: argv[argv.indexOf('-C') + 1], stdio: ['ignore', 'inherit', 'inherit'] })
  process.exit(r.status ?? 1)
}

async function main() {
  const sc = loadScenario()
  const pick = keys => Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))
  const call = stdin =>
    record('calls.jsonl', {
      argv,
      stdin,
      envNames: Object.keys(process.env).sort(),
      env: pick(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'TMPDIR', 'CODEX_HOME', 'PATH', 'TERM', 'LANG', 'USER']),
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
  if (argv[0] === 'sandbox') {
    if (sc.selftest === 'run') {
      call('')
      return runCommand()
    }
    if (sc.selftestConnect && !isReadOnlyPass() && !isSubdirPass()) await connectOnce(Number(argv.at(-1)))
    return answer(selfTestOutput(sc.selftest), sc.selftestExit ?? 0)
  }

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

  const stdin = await readStdin()
  call(stdin)

  for (const [rel, content] of Object.entries(sc.writeFiles ?? {})) {
    mkdirSync(dirname(rel), { recursive: true })
    writeFileSync(rel, content)
  }
  for (const rel of sc.deleteFiles ?? []) rmSync(rel, { force: true })
  if (sc.run !== undefined) {
    const r = spawnSync('/bin/sh', ['-c', sc.run], { input: stdin, stdio: ['pipe', 'inherit', 'inherit'] })
    process.exit(r.status ?? 1)
  }

  for (const item of sc.lines ?? []) {
    const { line, delayMs } = typeof item === 'string' ? { line: item } : item
    if (delayMs) await pause(delayMs)
    await write(process.stdout, line + '\n')
  }
  for (let i = 0; i < (sc.flood ?? 0); i++) await write(process.stdout, `${sc.floodLine ? sc.floodLine.replace('#', String(i)) : `{"flood":${i}}`}\n`)
  if (sc.bigLine) await write(process.stdout, `${sc.bigLine.text ?? ''}${'x'.repeat(sc.bigLine.bytes)}\n`)
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
