import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function ensureToken(file: string): string {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    try { chmodSync(file, 0o600) } catch { /* Windows */ }
  }
  return readFileSync(file, 'utf8').trim()
}
