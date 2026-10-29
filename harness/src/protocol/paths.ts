import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SOCK_MAX_BYTES = 103 // macOS sun_path 104 含结尾 0

export function dataDir(home: string = homedir()): string {
  return join(home, '.myFlowForge', 'mff-ai')
}

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)

export interface RuntimePaths {
  workerAddr: string
  controlAddr: string
  token: string
  supervisorJson: string
  startVbs: string
  db: string
  logs: string
  config: string
}

export function runtimePaths(dir: string, platform: NodeJS.Platform = process.platform): RuntimePaths {
  const run = join(dir, 'run')
  const h = sha8(dir)
  const addr = (name: 'worker' | 'control'): string => {
    if (platform === 'win32') return `\\\\.\\pipe\\mffai-${name}-${h}`
    const p = join(run, `${name}.sock`)
    return Buffer.byteLength(p) > SOCK_MAX_BYTES ? join(tmpdir(), `mffai-${h}-${name}.sock`) : p
  }
  return {
    workerAddr: addr('worker'),
    controlAddr: addr('control'),
    token: join(run, 'token'),
    supervisorJson: join(run, 'supervisor.json'),
    startVbs: join(run, 'start.vbs'),
    db: join(dir, 'db', 'events.sqlite'),
    logs: join(dir, 'logs'),
    config: join(dir, 'config.json'),
  }
}

const TOKEN_RE = /^[0-9a-f]{64}$/

function readValid(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim()
    return TOKEN_RE.test(t) ? t : null
  } catch {
    return null
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function ensureToken(file: string): string {
  mkdirSync(dirname(file), { recursive: true })
  let t = readValid(file)
  // 可能撞上并发写入的半成品:短暂重试
  for (let i = 0; !t && existsSync(file) && i < 5; i++) {
    sleepSync(20)
    t = readValid(file)
  }
  if (!t) {
    t = randomBytes(32).toString('hex')
    // 临时文件 + rename:读者不会看到半截文件
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(tmp, t, { mode: 0o600 })
    renameSync(tmp, file)
    return readValid(file) ?? t
  }
  if (process.platform !== 'win32') {
    try {
      if ((statSync(file).mode & 0o777) !== 0o600) chmodSync(file, 0o600)
    } catch { /* 忽略 */ }
  }
  return t
}
