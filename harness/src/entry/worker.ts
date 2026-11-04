import { BUILTIN_PLUGINS } from '../plugins/index'
import { createKernel, type Kernel } from '../kernel/kernel'
import { proxySocketParents, wipeSessionTmp } from '../kernel/sandbox'
import { startRpcServer } from '../kernel/rpcServer'
import { DRAIN_MS } from '../kernel/shutdown'
import { pgidFile, reapOrphans } from '../lib/proc/pgids'
import { sweepStaleNetDirs } from '../lib/sandbox/net/proxy'
import { HARNESS_VERSION } from '../kernel/version'
import { dataDir, ensureToken, runtimePaths } from '../protocol/index'
import { createFileLogger } from '../supervisor/fileLog'
import { createWatchdogHold } from './watchdogHold'


/** 工作进程:组装内核 → 监听 worker.sock → 告诉监管 ready;响应 ping / drain */
export async function runWorker(): Promise<void> {
  const dir = process.env.MFFAI_DATA_DIR || dataDir()
  const paths = runtimePaths(dir)
  const log = createFileLogger(paths.logs, 'worker')
  let kernel: Kernel | undefined
  let server: { close(): Promise<void> } | undefined
  let stopping = false
  let startup: Promise<void> = Promise.resolve()

  const stop = async (why: string) => {
    if (stopping) return
    stopping = true
    log.info('worker stopping', { why })
    // 启动中收到 drain / 断开:等启动结束再按正常路径关
    await startup.catch(() => {})
    try {
      await kernel?.drain(DRAIN_MS)
      await server?.close()
      await kernel?.close()
    } catch (err) {
      log.error('worker stop failed', { error: String(err) })
    }
    process.exit(0)
  }

  // 先挂 IPC:启动期间也能回 pong
  process.on('message', (m: { t?: string }) => {
    if (m?.t === 'ping') process.send?.({ t: 'pong' })
    else if (m?.t === 'drain') void stop('drain')
  })
  // 监管进程没了:自己体面退出
  process.on('disconnect', () => void stop('supervisor gone'))

  startup = (async () => {
    // 上一个工作进程崩溃时留下的 shell 进程组:先收掉,再建内核(spec §12)
    const pgids = pgidFile(dir)
    const { kept } = reapOrphans(pgids, { platform: process.platform, log })
    // 会话临时目录(沙箱里的 TMPDIR)不跨工作进程保留;在进程组收掉之后清,免得还在跑的命令又写回来
    wipeSessionTmp(dir, log)
    // 崩溃的工作进程留下的代理 socket 目录(本用户、owner 进程已不在):内核建代理之前清
    if (process.platform !== 'win32') {
      const swept = sweepStaleNetDirs(proxySocketParents(), { log })
      if (swept.length) log.info('stale proxy socket dirs removed', { count: swept.length })
    }
    // MFFAI_SECRETS_PLAINTEXT=1:端到端测试用,不碰系统钥匙串
    const secrets = { osBackend: process.env.MFFAI_SECRETS_PLAINTEXT !== '1' }
    kernel = await createKernel({ dataDir: dir, plugins: BUILTIN_PLUGINS, log, secrets, pgidFile: pgids, pgidSeed: kept, holdWatchdog: createWatchdogHold() })
    const k = kernel
    server = await startRpcServer({
      addr: paths.workerAddr,
      token: ensureToken(paths.token),
      version: HARNESS_VERSION,
      events: k.events,
      handle: (method, params) => k.handle(method, params),
    })
  })()
  try {
    await startup
  } catch (err) {
    log.error('worker start failed', { error: err instanceof Error ? err.stack ?? err.message : String(err) })
    if (!stopping) process.exit(1)
    return
  }
  if (stopping) return
  log.info('worker ready', { pid: process.pid, addr: paths.workerAddr })
  process.send?.({ t: 'ready' })
}
