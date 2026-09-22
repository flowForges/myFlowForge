import { z } from 'zod'
import { randomBytes, randomUUID } from 'node:crypto'
import { sysFile } from '../config/paths'
import { readJson, writeJson } from '../config/store'
import { readDaemonConfig, resetToken } from '../daemon/config'
import { tokenMatches, type TokenAuth } from './serveConnection'

/**
 * 「谁能连进这台电脑」—— 按设备发令牌,可以单独移除。
 *
 * ★★为什么:原来整台机器只有**一把**共用令牌。用户 2026-09-22 原话:「点击中断,然后发现又会自动连上,
 *  我怎么永久剔除呢?如果我连接秘钥泄露了,如何重置呢?」—— 「断开」只断一次(对方拿着有效令牌自动重连),
 *  想踢掉一台只能换令牌,而换令牌 = 所有人一起重新配对;更糟的是换完正在跑的网关还认旧的。
 *
 * - 每生成一枚配对码就发一把新令牌(上一把还没被用过就复用,免得点一次多一条)。
 * - 设备第一次连上时,用它自报的名字给这一条起名。
 * - 移除 = 删掉令牌 + 当场用 4403 断开它现有的连接 —— 客户端见到 4403 不会自动重连。
 * - 升级前配对的设备拿的都是那把共用令牌(`daemon.json`)。它作为一条「旧配对码」留在表里照常能用,
 *   撤销它就是「之前配对的那些一起作废」。
 *
 * ★客户端一行不用改:它照旧带一个 `t=` 令牌,只是现在每台设备的不一样。Linux daemon 仍用共用令牌。
 */

export const LEGACY_ID = 'legacy'

const DeviceSchema = z.object({
  id: z.string(),
  token: z.string(),
  /** 空 = 还没有设备用过这枚码 */
  label: z.string().catch(''),
  createdAt: z.number().catch(0),
  /** 0 = 从没连上过 */
  lastSeenAt: z.number().catch(0),
})
const FileSchema = z.object({
  version: z.literal(1).catch(1),
  devices: z.array(DeviceSchema).catch([]),
  /** 共用的旧令牌是否已撤销。撤销后 `daemon.json` 里那把也会被换掉。 */
  legacyRevoked: z.boolean().catch(false),
})
type File = z.infer<typeof FileSchema>

/** 给界面看的一行。★不带令牌 —— 令牌只在生成配对码那一刻给出去。 */
export type AuthorizedDevice = {
  id: string
  label: string
  createdAt: number
  lastSeenAt: number
  legacy: boolean
  /** 这枚码还没被任何设备用过 */
  pending: boolean
  online: boolean
}

const file = () => sysFile('device-tokens.json')
const read = (): File => readJson(file(), FileSchema, () => ({ version: 1, devices: [], legacyRevoked: false }))
const write = (f: File) => writeJson(file(), FileSchema.parse(f))

/** 撤销时要踢掉的连接:deviceId → 每条连接各一个「断开它」。 */
const live = new Map<string, Set<() => void>>()
const listeners = new Set<() => void>()
const changed = () => { for (const l of listeners) { try { l() } catch { /* 一个订阅者出错不连累别人 */ } } }

/** 列表(或在线状态)变了。设置页靠它刷新。 */
export function onDevicesChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** 旧的共用令牌:没撤销、并且真的存在过(全新安装根本没有这一条)。 */
function legacyToken(f: File): string {
  if (f.legacyRevoked) return ''
  return readDaemonConfig().token
}

export function listDevices(): AuthorizedDevice[] {
  const f = read()
  const rows: AuthorizedDevice[] = f.devices.map((d) => ({
    id: d.id, label: d.label, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
    legacy: false, pending: d.lastSeenAt === 0, online: (live.get(d.id)?.size ?? 0) > 0,
  }))
  if (legacyToken(f)) {
    rows.unshift({ id: LEGACY_ID, label: '', createdAt: 0, lastSeenAt: 0, legacy: true, pending: false, online: (live.get(LEGACY_ID)?.size ?? 0) > 0 })
  }
  return rows
}

/**
 * 给新设备的配对令牌。★上一把还没被用过就复用它:展开 / 收起二维码、重开设置页都不该凭空多出一条。
 */
export function pairingToken(now = Date.now()): { id: string; token: string } {
  const f = read()
  const unused = [...f.devices].reverse().find((d) => d.lastSeenAt === 0)
  if (unused) return { id: unused.id, token: unused.token }
  const d = { id: randomUUID(), token: randomBytes(32).toString('base64url'), label: '', createdAt: now, lastSeenAt: 0 }
  write({ ...f, devices: [...f.devices, d] })
  changed()
  return { id: d.id, token: d.token }
}

/** 这把令牌是哪台设备的。定长比较,一把一把试,不让「第几个字符开始不同」变成旁路。 */
export function checkToken(got: string): string | null {
  if (!got) return null
  const f = read()
  let hit: string | null = null
  for (const d of f.devices) if (tokenMatches(d.token, got)) hit = d.id
  const legacy = legacyToken(f)
  if (legacy && tokenMatches(legacy, got)) hit = LEGACY_ID
  return hit
}

/** 连上了:记下时间,第一次连上时用它自报的名字给这一条起名(只在名字还空着时)。 */
export function touchDevice(id: string, label: string, now = Date.now()): void {
  if (id === LEGACY_ID) return
  const f = read()
  const d = f.devices.find((x) => x.id === id)
  if (!d) return
  const nextLabel = d.label || (label && label !== '远程客户端' && label !== '正在连接…' ? label : '')
  if (d.lastSeenAt !== 0 && nextLabel === d.label && now - d.lastSeenAt < 60_000) return  // 别每条连接都写盘
  write({ ...f, devices: f.devices.map((x) => (x.id === id ? { ...x, lastSeenAt: now, label: nextLabel } : x)) })
  changed()
}

function kickLive(id: string): void {
  const set = live.get(id)
  live.delete(id)
  for (const k of set ?? []) { try { k() } catch { /* 已经断了 */ } }
}

/** 移除一台:令牌作废 + 它现在的连接立刻断开(4403,不会自动重连)。 */
export function revokeDevice(id: string): void {
  const f = read()
  if (id === LEGACY_ID) {
    write({ ...f, legacyRevoked: true })
    resetToken()   // 共用令牌也换掉 —— 别让它留在磁盘上还能被别处(旧版本 / daemon)认
  } else {
    write({ ...f, devices: f.devices.filter((d) => d.id !== id) })
  }
  kickLive(id)
  changed()
}

/** 全部撤销:令牌泄露又不知道是哪一台时用。之后要继续用的设备重新配对。 */
export function revokeAll(): void {
  const f = read()
  write({ version: 1, devices: [], legacyRevoked: true })
  if (!f.legacyRevoked) resetToken()
  for (const id of [...live.keys()]) kickLive(id)
  changed()
}

/** 交给 serveConnection 的鉴权:局域网网关和中转共用这一个,所以两条路上「移除」同时生效。 */
export function deviceAuth(): TokenAuth {
  return {
    check: checkToken,
    seen: (id, label) => touchDevice(id, label),
    bind: (id, revoke) => {
      let set = live.get(id)
      if (!set) { set = new Set(); live.set(id, set) }
      set.add(revoke)
      changed()
      return () => {
        const s = live.get(id)
        if (s) { s.delete(revoke); if (!s.size) live.delete(id) }
        changed()
      }
    },
  }
}
