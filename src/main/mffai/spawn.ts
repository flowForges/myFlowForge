import { spawn } from 'node:child_process'

export type SpawnFn = (cmd: string, args: string[], opts: {
  detached: boolean
  stdio: 'ignore'
  env: NodeJS.ProcessEnv
}) => { unref(): void; on?(ev: 'error', cb: (err: Error) => void): unknown }

export interface SpawnSpec {
  execPath: string
  /** out/main/mffaiDaemon.js。★由 index.ts 用自己的 __dirname 算:host 被拆进 chunks/,那里的 __dirname 不对 */
  daemonJs: string
  dataDir: string
}

/**
 * 拉起监管进程:detached + unref,活过 app 退出。
 * ★刻意不用 spawnAgent / trackAgentChild:那两个会在 app 退出时被 killAllAgentTrees() 杀掉。
 */
export function spawnDaemon(spec: SpawnSpec, spawnFn: SpawnFn = spawn as unknown as SpawnFn): void {
  const child = spawnFn(spec.execPath, [spec.daemonJs], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MFFAI_DATA_DIR: spec.dataDir },
  })
  // 拉不起来(ENOENT 等)由调用方的等待超时报告;不能让 'error' 无人监听而炸掉主进程
  child.on?.('error', () => {})
  child.unref()
}
