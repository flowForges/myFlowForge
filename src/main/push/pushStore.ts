import { chmodSync, existsSync } from 'node:fs'
import { z } from 'zod'
import { sysFile } from '../config/paths'
import { readJson, writeJson } from '../config/store'

/**
 * 已经登记要收推送的设备。
 *
 * ★`0600`:一枚 Expo push token **就是**「往这台手机弹通知」的能力本身 —— 拿到它的人
 *  不需要任何别的凭据就能给用户推东西。它不像访问令牌那样能换一个了事(换要用户重开 app),
 *  所以按私钥的规格存,和 `identity.json` 一致。
 *
 * ★**在场状态不落盘**,只活在内存里(见 `pushBridge`)。落盘的话 daemon 重启后会捡回一份
 *  「他正看着呢」的旧快照 —— 而重启时人多半根本不在 —— 于是**第一批推送被静默吃掉**,
 *  症状是「重启电脑那天晚上一条推送都没有」,还极难联想到是这儿。
 */
export const PushDeviceSchema = z.object({
  /** Expo push token(`ExponentPushToken[...]`)。设备的唯一键。 */
  token: z.string(),
  /** 给人看的名字,设置里列出来用。 */
  label: z.string().catch(''),
  platform: z.enum(['ios', 'android', 'web']).catch('ios'),
  registeredAt: z.number().catch(0),
  /** 最近一次连上来。太久没露面的设备可以在设置里删掉。 */
  lastSeenAt: z.number().catch(0),
})
export type PushDevice = z.infer<typeof PushDeviceSchema>

export const PushDevicesFileSchema = z.object({
  version: z.literal(1).catch(1),
  devices: z.array(PushDeviceSchema).catch([]),
})

/**
 * 最多记几台。
 *
 * ★不是怕用户有 33 台手机,是怕**同一台手机换出一串新 token**:重装 app、恢复备份、
 *  某些 ROM 清数据之后 Expo 会发新 token,旧的再也不会有人来注销。没有上限的话这张表
 *  只增不减,而每一条都会在每次推送时被真的 POST 一遍 —— 变成一个越用越慢、
 *  还持续给三方服务器发死令牌的东西。超了先挤掉最久没露面的那台。
 */
export const MAX_DEVICES = 32

const file = () => sysFile('push-devices.json')

export function readDevices(): PushDevice[] {
  return readJson(file(), PushDevicesFileSchema, () => ({ version: 1 as const, devices: [] })).devices
}

function write(devices: PushDevice[]): PushDevice[] {
  writeJson(file(), { version: 1, devices })
  // ★权限每次都补一遍:`writeJsonAtomic` 是「写临时文件再 rename」,新文件带的是进程 umask 的
  //  权限,rename 之后旧文件那个 0600 **不会**留下来。只在创建时 chmod 一次的话,第二次写入
  //  就悄悄变回 0644 了。
  try { if (existsSync(file())) chmodSync(file(), 0o600) } catch { /* Windows 上没这回事 */ }
  return devices
}

/** 登记/更新一台设备。按 token 认人;重复登记只更新名字和时间,不新增一条。 */
export function registerDevice(d: { token: string; label?: string; platform?: PushDevice['platform'] }, now: number): PushDevice[] {
  const token = d.token.trim()
  if (!token) throw new Error('推送令牌是空的')
  const devices = readDevices()
  const i = devices.findIndex((x) => x.token === token)
  const next: PushDevice = {
    token,
    label: (d.label ?? '').trim().slice(0, 64),
    platform: d.platform ?? 'ios',
    registeredAt: i >= 0 ? devices[i]!.registeredAt || now : now,
    lastSeenAt: now,
  }
  if (i >= 0) devices[i] = next
  else devices.push(next)
  // 超了挤掉最久没露面的。★按 lastSeenAt 而不是 registeredAt —— 一台天天在用的老设备
  //  不该被一台注册过一次就再没出现过的新设备顶掉。
  if (devices.length > MAX_DEVICES) {
    devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    devices.length = MAX_DEVICES
  }
  return write(devices)
}

export function removeDevice(token: string): PushDevice[] {
  return write(readDevices().filter((d) => d.token !== token))
}

/** 一次摘掉多枚死令牌(Expo 回 `DeviceNotRegistered` 时用)。 */
export function removeDevices(tokens: readonly string[]): PushDevice[] {
  if (!tokens.length) return readDevices()
  const dead = new Set(tokens)
  return write(readDevices().filter((d) => !dead.has(d.token)))
}

/** 设备又露面了。★找不到就什么都不做 —— 不要凭一次 presence 把设备偷偷登记进来。 */
export function touchDevice(token: string, now: number): void {
  const devices = readDevices()
  const i = devices.findIndex((x) => x.token === token)
  if (i < 0) return
  devices[i] = { ...devices[i]!, lastSeenAt: now }
  write(devices)
}
