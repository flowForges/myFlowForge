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
  /**
   * 这台主机的标识:一个 emoji(或留空用默认)。
   * ★为什么要有:标题栏正中挂一串主机名太抢眼了。一个你自己认得的表情就够了 ——
   * 这个位置需要的是「一眼认出是哪台」,不是「读完一个名字」。
   */
  icon: z.string().max(8).catch(''),
  /** 芯片上显示什么:只显示标识 / 只显示名字 / 两个都显示。 */
  display: z.enum(['icon', 'name', 'both']).catch('both'),
  token: z.string().catch(''),
  /**
   * 对面 daemon 的长期公钥(base64,44 字符)。**有它就端到端加密。**
   *
   * ★可选:老记录没有,那些主机继续按明文直连工作 —— 一次升级不该让已经配好的主机失效。
   * ★从**配对码**里来(`myflowforge://add-host?...&k=`),不给人手填:44 个字符的 base64
   *  没人核对得了,错一个字符只会静默连不上。和手机端同一条规矩。
   */
  pubKey: z.string().catch(''),
  /**
   * 中转地址(`wss://…`)。有它就不直连,拨到中转进 daemon 的房间。
   * ★★必须配 `pubKey`。没有身份验证的中转 = 把令牌和全部内容交给一台第三方服务器 ——
   *  `remoteClient` 会把这种组合当**配置错误直接失败**,绝不悄悄降级成明文中转。
   */
  relay: z.string().catch(''),
  lastConnectedAt: z.number().catch(0),
})
export type RemoteHost = z.infer<typeof RemoteHostSchema>

export const HostsFileSchema = z.object({
  version: z.literal(1).catch(1),
  hosts: z.array(RemoteHostSchema).catch([]),
})
export type HostsFile = z.infer<typeof HostsFileSchema>

const defaultHosts = (): HostsFile => ({ version: 1, hosts: [] })
/** 导入专用:`id` 可选(见 `importHosts` 里那段)。其余字段和落盘那张完全一致。 */
const ImportFileSchema = z.object({
  version: z.literal(1).catch(1),
  hosts: z.array(RemoteHostSchema.extend({ id: z.string().optional() })).catch([]),
})

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
    icon: input.icon,
    display: input.display,
    token: input.token,
    // ★★这里是**显式字段列表**:schema 加了字段而这儿忘了跟上,新字段会在保存时静默消失,
    //  而两边看起来都对。手机端的 `loadHosts` 就是这么丢掉 pubKey/relay 的
    //  (配好的中转主机重启 app 就退回明文直连、然后连不上)。有测试钉着,见 hostStore.test.ts。
    pubKey: input.pubKey,
    relay: input.relay,
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
      icon: h.icon, display: h.display,
      // ★同上,第二处显式字段列表。★公钥和中转地址**不是**凭据:公钥按定义就是公开的,
      //  中转地址只是个地址。所以它们跟着导出,不受 `includeTokens` 管 —— 不带的话
      //  导出的中转主机到了另一台设备上会退化成一条连不上的明文直连记录。
      pubKey: h.pubKey, relay: h.relay,
      token: opts.includeTokens ? h.token : '',
    })),
  }, null, 2)
}

/** 导入:按 label 去重覆盖,其余追加。返回这次真正落盘的条数。 */
export function importHosts(text: string): { ok: true; added: number } | { ok: false; error: string } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, error: '不是合法的 JSON' } }
  // ★★导入用的是一张**`id` 可选**的 schema —— `exportHosts` 根本不写 `id`(它是本机的
  //  内部标识,搬到另一台设备上没有意义),而 `RemoteHostSchema` 的 `id: z.string()` 没有
  //  `.catch()` ⇒ 用它 parse 会整份失败,报「里面没有可导入的主机」。
  //  **这是个既有 bug:导出的东西自己导不回来**,「在设备之间搬清单」一直不工作。
  //  2026-09-02 给 pubKey/relay 补往返测试时撞出来的(那条测试到今天才第一次真的跑通导入)。
  const p = ImportFileSchema.safeParse({ version: 1, hosts: (parsed as { hosts?: unknown })?.hosts ?? [] })
  if (!p.success || p.data.hosts.length === 0) return { ok: false, error: '里面没有可导入的主机' }
  const f = readHosts()
  const byLabel = new Map(f.hosts.map((h) => [h.label, h]))
  for (const h of p.data.hosts) {
    const prev = byLabel.get(h.label)
    // 导入的那份 token 可能是空的(导出时没选带凭据)。这时保留本机已有的,别把它清掉。
    byLabel.set(h.label, {
      ...h,
      // 导入的那份可能带着来源设备的 id(手工拼的 JSON),也可能没有(标准导出)。
      // 本机已有同名的就沿用本机那个 id —— 换 id 会让「当前连着的是哪台」瞬间对不上。
      id: prev?.id ?? h.id ?? randomUUID(),
      token: h.token || prev?.token || '',
      lastConnectedAt: prev?.lastConnectedAt ?? 0,
    })
  }
  writeHosts({ version: 1, hosts: [...byLabel.values()] })
  return { ok: true, added: p.data.hosts.length }
}
