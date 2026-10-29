import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { HARNESS_VERSION } from '../kernel/version'
import { PROTOCOL_VERSION, connectControlClient, dataDir, ensureToken, runtimePaths, type ControlStatus } from '../protocol/index'
import { startControlServer } from '../supervisor/controlServer'
import { createFileLogger } from '../supervisor/fileLog'
import { Supervisor } from '../supervisor/supervisor'
import { runWorker } from './worker'

// mffaiDaemon.js:无参数为监管进程,--worker 为工作进程

async function alreadyRunning(addr: string, token: string): Promise<boolean> {
  try {
    const c = await connectControlClient({ addr, token, timeoutMs: 2000 })
    try {
      await c.call('status')
      return true
    } finally {
      c.close()
    }
  } catch {
    return false
  }
}

function writeJsonAtomic(file: string, data: object): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

export async function runSupervisor(): Promise<void> {
  const dir = process.env.MFFAI_DATA_DIR || dataDir()
  const paths = runtimePaths(dir)
  const log = createFileLogger(paths.logs, 'supervisor')
  let token = ensureToken(paths.token)

  // 单实例:已有监管能答 status 就退出
  if (await alreadyRunning(paths.controlAddr, token)) {
    log.info('already running, exit')
    process.exit(0)
  }

  const startedAt = Date.now()
  let jsonGone = false
  const writeJson = (s: ControlStatus) => {
    if (jsonGone) return
    try {
      writeJsonAtomic(paths.supervisorJson, {
        pid: process.pid,
        workerPid: s.workerPid,
        version: HARNESS_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        startedAt,
        state: s.state,
        ...(s.trippedReason ? { trippedReason: s.trippedReason } : {}),
      })
    } catch (err) {
      log.error('write supervisor.json failed', { error: String(err) })
    }
  }

  let held = false // 拿到控制口之前不写 supervisor.json
  const supervisor = new Supervisor({
    workerCmd: process.execPath,
    workerArgs: [__filename, '--worker'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MFFAI_DATA_DIR: dir },
    log,
    onState: s => held && writeJson(s),
  })

  let stopping = false
  let control: { close(): Promise<void> } | undefined
  const stop = async () => {
    if (stopping) return
    stopping = true
    log.info('shutdown')
    await supervisor.shutdown()
    await control?.close()
    writeJson({ ...supervisor.state(), state: 'stopping' })
    jsonGone = true
    rmSync(paths.supervisorJson, { force: true })
    process.exit(0)
  }

  // 独占监听控制口即单实例锁;抢输了直接退出
  const listen = () => startControlServer({ addr: paths.controlAddr, token, supervisor, onShutdown: stop })
  try {
    control = await listen()
    // 并发首启时两边可能各生成过 token,以最终落盘的为准
    const onDisk = ensureToken(paths.token)
    if (onDisk !== token) {
      await control.close()
      token = onDisk
      control = await listen()
    }
  } catch (err) {
    if ((err as Error).message === 'address in use') {
      log.info('lost single-instance race, exit')
      process.exit(0)
    }
    log.error('control server failed', { error: String(err) })
    process.exit(1)
  }

  held = true
  log.info('supervisor started', { pid: process.pid, version: HARNESS_VERSION })
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  await supervisor.start()
}

export function main(): Promise<void> {
  return process.argv.includes('--worker') ? runWorker() : runSupervisor()
}

// 打包成 CJS 后作为入口运行;被 import(测试)时不自动启动
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) void main()
