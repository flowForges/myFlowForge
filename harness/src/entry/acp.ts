import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { connectClient, runtimePaths } from '../protocol/index'
import { acpDataDir } from './acpDataDir'
import { runBridge } from '../acp-bridge/bridge'

// mffaiAcp.js:stdio 上的 ACP agent,转接到已在运行的 mff-ai 工作进程(不自行拉起)
// 构建期的 app 数据目录名(electron.vite.config.ts 的 define,测试包是 .myFlowForge-test),跟 app 的 MFFAI_DIR 同源
declare const __MFF_SYS_DIR_NAME__: string | undefined
const paths = runtimePaths(acpDataDir(process.env, typeof __MFF_SYS_DIR_NAME__ === 'string' ? __MFF_SYS_DIR_NAME__ : undefined))

void runBridge({
  stream: ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
  connect: async () => {
    const token = readFileSync(paths.token, 'utf8').trim() // 只读,不创建
    return connectClient({ addr: paths.workerAddr, token, timeoutMs: 3000 })
  },
}).then(
  () => process.exit(0),
  (e) => {
    process.stderr.write(`mff-ai acp bridge failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(1)
  },
)
