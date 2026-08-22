import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { sysFile } from '../config/paths'
import { readJson, writeJson } from '../config/store'

/**
 * 多台机器的清单。**存在客户端本地**(决策 B-1)。
 *
 * 为什么不让 daemon 也存一份、客户端连上谁就同步:清单里带着凭据。让服务器帮忙在设备之间
 * 搬凭据,就把「中转/服务器只是个不可信哑管道」这条安全前提破掉了 —— 那是密钥分发问题,
 * 复杂度和风险都高一个量级。加新设备靠**导出/导入**,一次性的手工成本换掉一整类风险。
 */
export const RemoteHostSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** 'direct' = 直接连这个地址;'ssh' = 由 app 拉一条 SSH 隧道再连本地端口 */
  kind: z.enum(['direct', 'ssh']).catch('direct'),
  /** direct: `ws://host:port`。ssh: 远端 daemon 在**它自己机器上**监听的端口 */
  address: z.string().catch(''),
  /** ssh 专用:`user@host`(可带 `:port`) */
  sshTarget: z.string().catch(''),
  token: z.string().catch(''),
  lastConnectedAt: z.number().catch(0),
})
export type RemoteHost = z.infer<typeof RemoteHostSchema>

export const HostsFileSchema = z.object({
  version: z.literal(1).catch(1),
  hosts: z.array(RemoteHostSchema).catch([]),
})
export type HostsFile = z.infer<typeof HostsFileSchema>

const defaultHosts = (): HostsFile => ({ version: 1, hosts: [] })
const file = () => sysFile('hosts.json')

export const readHosts = (): HostsFile => readJson(file(), HostsFileSchema, defaultHosts)
export const writeHosts = (h: HostsFile) => writeJson(file(), HostsFileSchema.parse(h))

export function upsertHost(input: Omit<RemoteHost, 'id' | 'lastConnectedAt'> & { id?: string }): RemoteHost {
  const f = readHosts()
  const id = input.id || randomUUID()
  const existing = f.hosts.find((h) => h.id === id)
  const next: RemoteHost = {
    id,
    label: input.label,
    kind: input.kind,
    address: input.address,
    sshTarget: input.sshTarget,
    token: input.token,
    lastConnectedAt: existing?.lastConnectedAt ?? 0,
  }
  writeHosts({ ...f, hosts: existing ? f.hosts.map((h) => (h.id === id ? next : h)) : [...f.hosts, next] })
  return next
}

export function removeHost(id: string): HostsFile {
  const f = readHosts()
  const next = { ...f, hosts: f.hosts.filter((h) => h.id !== id) }
  writeHosts(next)
  return next
}

export function markConnected(id: string, at: number): void {
  const f = readHosts()
  writeHosts({ ...f, hosts: f.hosts.map((h) => (h.id === id ? { ...h, lastConnectedAt: at } : h)) })
}

/**
 * 导出给另一台设备。★**默认不带 token** —— 导出的这段文本很可能被贴进聊天软件、
 * 记事本、截图。凭据要不要跟着走,必须是用户当场明确选的,不能是默认。
 */
export function exportHosts(opts: { includeTokens: boolean }): string {
  const f = readHosts()
  return JSON.stringify({
    version: 1,
    hosts: f.hosts.map((h) => ({
      label: h.label, kind: h.kind, address: h.address, sshTarget: h.sshTarget,
      token: opts.includeTokens ? h.token : '',
    })),
  }, null, 2)
}

/** 导入:按 label 去重覆盖,其余追加。返回这次真正落盘的条数。 */
export function importHosts(text: string): { ok: true; added: number } | { ok: false; error: string } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, error: '不是合法的 JSON' } }
  const p = HostsFileSchema.safeParse({ version: 1, hosts: (parsed as { hosts?: unknown })?.hosts ?? [] })
  if (!p.success || p.data.hosts.length === 0) return { ok: false, error: '里面没有可导入的主机' }
  const f = readHosts()
  const byLabel = new Map(f.hosts.map((h) => [h.label, h]))
  for (const h of p.data.hosts) {
    const prev = byLabel.get(h.label)
    // 导入的那份 token 可能是空的(导出时没选带凭据)。这时保留本机已有的,别把它清掉。
    byLabel.set(h.label, {
      ...h,
      id: prev?.id ?? randomUUID(),
      token: h.token || prev?.token || '',
      lastConnectedAt: prev?.lastConnectedAt ?? 0,
    })
  }
  writeHosts({ version: 1, hosts: [...byLabel.values()] })
  return { ok: true, added: p.data.hosts.length }
}
