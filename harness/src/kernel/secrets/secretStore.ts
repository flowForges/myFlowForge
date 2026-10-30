import { createHash, randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { SecretsBackend } from '../../protocol/index'
import { nullLogger, type Logger } from '../log'
import { dpapiBackend } from './dpapiWin'
import { decryptMap, encryptMap } from './encryptedFile'
import { KeyUnreadableError, realExec, withTimeout, type Exec } from './exec'
import { keychainBackend } from './keychainMac'
import { ensurePrivateDir, parseMap, readPrivate, writePrivate } from './plainFile'
import { secretServiceBackend } from './secretServiceLinux'

export interface SecretStore {
  readonly backend: SecretsBackend
  get(k: string): Promise<string | undefined>
  set(k: string, v: string): Promise<void>
  delete(k: string): Promise<void>
}

export interface MasterKeyBackend {
  name: 'keychain' | 'dpapi' | 'secret-service'
  probe(): Promise<boolean>
  /** 不存在 → undefined;后端故障 → 抛错;解不开 → 抛 KeyUnreadableError */
  load(): Promise<Buffer | undefined>
  save(key: Buffer): Promise<void>
}

export interface OpenSecretStoreOpts {
  dataDir: string
  platform?: NodeJS.Platform
  exec?: Exec
  /** false:不碰任何系统钥匙串,直接用明文文件 */
  osBackend?: boolean
  /** 仅测试:指定 macOS 钥匙串文件 */
  macKeychainPath?: string
  timeoutMs?: number
  log?: Logger
}

const ENC = 'credentials.enc'
const PLAIN = 'credentials.json'

const sha8 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8)
const kind = (err: unknown) => (err instanceof Error ? err.message : 'error')

/** 打开凭据存储:启动时探测一次主密钥后端并固定;从不抛错(后端或文件系统故障 → unavailable) */
export async function openSecretStore(opts: OpenSecretStoreOpts): Promise<SecretStore> {
  const log = opts.log ?? nullLogger
  const stage = { backend: 'none' as string }
  try {
    return await open(opts, log, stage)
  } catch (err) {
    // 文件系统错误(EACCES / EPERM / EISDIR …):只记错误码
    const code = (err as NodeJS.ErrnoException)?.code ?? 'fs'
    log.warn('secrets backend unavailable', { backend: stage.backend, failure: code })
    return lockedStore('unavailable')
  }
}

async function open(opts: OpenSecretStoreOpts, log: Logger, stage: { backend: string }): Promise<SecretStore> {
  const dir = opts.dataDir
  ensurePrivateDir(dir)
  const encPath = join(dir, ENC)
  const plainPath = join(dir, PLAIN)
  const run = withTimeout(opts.exec ?? realExec, opts.timeoutMs ?? 5000)
  const account = sha8(dir)
  const platform = opts.platform ?? process.platform

  let os: MasterKeyBackend | undefined
  if (opts.osBackend !== false) {
    if (platform === 'darwin') os = keychainBackend(run, account, log, opts.macKeychainPath)
    else if (platform === 'win32') os = dpapiBackend(run, join(dir, 'master.dpapi'))
    else if (platform === 'linux') os = secretServiceBackend(run, account, log)
  }
  const ok = os ? await os.probe().catch(() => false) : false

  if (!os || !ok) {
    // 已有加密文件:不悄悄换成明文(否则旧凭据全部"消失")
    if (existsSync(encPath)) {
      log.warn('secrets backend unavailable', { backend: os?.name ?? 'none', failure: 'probe' })
      return lockedStore('unavailable')
    }
    log.info('secrets backend', { backend: 'plaintext-file', probed: os?.name ?? 'none' })
    stage.backend = 'plaintext-file'
    return plaintextStore(plainPath)
  }

  stage.backend = os.name
  let key: Buffer | undefined
  try {
    key = await os.load()
  } catch (err) {
    if (err instanceof KeyUnreadableError) {
      log.warn('secrets unreadable', { backend: os.name, failure: kind(err) })
      return lockedStore('unreadable')
    }
    log.warn('secrets backend unavailable', { backend: os.name, failure: kind(err) })
    return lockedStore('unavailable')
  }
  if (!key) {
    // 主密钥"不存在"但密文还在:再探一次,区分后端刚掉线(unavailable)与主密钥真丢了(unreadable);都保留文件
    if (existsSync(encPath)) {
      if (!(await os.probe().catch(() => false))) {
        log.warn('secrets backend unavailable', { backend: os.name, failure: 'probe' })
        return lockedStore('unavailable')
      }
      log.warn('secrets unreadable', { backend: os.name, failure: 'master key missing' })
      return lockedStore('unreadable')
    }
    key = randomBytes(32)
    try {
      await os.save(key)
    } catch (err) {
      log.warn('secrets backend unavailable', { backend: os.name, failure: kind(err) })
      return lockedStore('unavailable')
    }
  }

  const master = key
  let map: Record<string, string> = {}
  const text = readPrivate(encPath)
  if (text !== undefined) {
    try {
      map = decryptMap(master, text)
    } catch {
      log.warn('secrets unreadable', { backend: os.name, failure: 'decrypt' })
      return lockedStore('unreadable')
    }
  }
  const store = mapStore(os.name, map, m => writePrivate(encPath, encryptMap(master, m)))
  // 之前退回过明文:并入加密文件后删除明文
  const plain = readPrivate(plainPath)
  if (plain !== undefined) {
    try {
      const old = parseMap(plain)
      for (const [k, v] of Object.entries(old)) if (!(k in map)) await store.set(k, v)
      rmSync(plainPath, { force: true })
    } catch {
      // 不记录错误文本:JSON 解析错误会带出文件片段
      log.warn('plaintext migration failed', { failure: 'parse' })
    }
  }
  log.info('secrets backend', { backend: os.name })
  return store
}

function plaintextStore(file: string): SecretStore {
  const text = readPrivate(file)
  let map: Record<string, string> = {}
  if (text !== undefined) {
    try { map = parseMap(text) } catch { return lockedStore('unreadable') }
  }
  return mapStore('plaintext-file', map, m => writePrivate(file, JSON.stringify(m, null, 2)))
}

/** 内存映射 + 每次写入整体落盘;写入串行 */
function mapStore(backend: SecretsBackend, initial: Record<string, string>, persist: (m: Record<string, string>) => void): SecretStore {
  const map = new Map(Object.entries(initial))
  let chain: Promise<void> = Promise.resolve()
  // 先落盘副本,成功后才改内存:写失败时 get 仍返回旧值
  const write = (mutate: (m: Map<string, string>) => boolean) => {
    const next = chain.then(() => {
      const copy = new Map(map)
      if (!mutate(copy)) return
      persist(Object.fromEntries(copy))
      map.clear()
      for (const [k, v] of copy) map.set(k, v)
    })
    chain = next.catch(() => {})
    return next
  }
  return {
    backend,
    get: async k => map.get(k),
    set: (k, v) => write(m => { m.set(k, v); return true }),
    delete: k => write(m => m.delete(k)),
  }
}

/** unavailable / unreadable:读返回 undefined,写抛错,磁盘上的数据原样保留 */
function lockedStore(backend: 'unavailable' | 'unreadable'): SecretStore {
  const fail = async () => { throw new Error(`secrets ${backend}`) }
  return { backend, get: async () => undefined, set: fail, delete: fail }
}

/** 插件视图:键加 `<pluginId>/` 前缀;没有列举接口 */
export function scopedSecrets(store: SecretStore, pluginId: string): { get(k: string): Promise<string | undefined>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> } {
  // id 里带 `/` 会让前缀互相覆盖(`a` 与 `a/b`)
  if (!pluginId || pluginId.includes('/')) throw new Error(`invalid plugin id for secrets: ${pluginId}`)
  const p = `${pluginId}/`
  return {
    get: k => store.get(p + k),
    set: (k, v) => store.set(p + k, v),
    delete: k => store.delete(p + k),
  }
}
