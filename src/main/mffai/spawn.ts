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
 * 后台的环境(spec §8.3 cleanEnv):继承 app 的环境(PATH / HOME / 代理等照旧),
 * 去掉 NODE_OPTIONS、全部 ELECTRON_*(调试开关等)和 npm_*;ELECTRON_RUN_AS_NODE 重新设为 1。
 */
export function daemonEnv(base: NodeJS.ProcessEnv, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (k === 'NODE_OPTIONS' || k.startsWith('ELECTRON_') || /^npm_/i.test(k)) continue
    env[k] = v
  }
  env.ELECTRON_RUN_AS_NODE = '1'
  env.MFFAI_DATA_DIR = dataDir
  return env
}

/**
 * 拉起监管进程:detached + unref,活过 app 退出。
 * ★刻意不用 spawnAgent / trackAgentChild:那两个会在 app 退出时被 killAllAgentTrees() 杀掉。
 */
export function spawnDaemon(
  spec: SpawnSpec,
  spawnFn: SpawnFn = spawn as unknown as SpawnFn,
  onError: (err: Error) => void = () => {},
): void {
  const child = spawnFn(spec.execPath, [spec.daemonJs], {
    detached: true,
    stdio: 'ignore',
    env: daemonEnv(process.env, spec.dataDir),
  })
  // 拉不起来(ENOENT 等)交给调用方记录;不能让 'error' 无人监听而炸掉主进程
  child.on?.('error', onError)
  child.unref()
}
