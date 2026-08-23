/** 渲染层看到的一台远程主机。★不含 token —— 凭据没有任何理由进渲染进程。 */
export type HostDisplay = 'icon' | 'name' | 'both'

export type RemoteHostView = {
  id: string
  label: string
  kind: 'direct' | 'ssh'
  address: string
  sshTarget: string
  /** 一个 emoji;空 = 用默认 */
  icon: string
  display: HostDisplay
  token: string
  lastConnectedAt: number
}

/** 没设标识时的默认。本机用另一个,好一眼分开。 */
export const DEFAULT_HOST_ICON = '🖥️'
export const LOCAL_ICON = '💻'

export type HostInput = {
  id?: string
  label: string
  kind: 'direct' | 'ssh'
  address: string
  sshTarget: string
  icon: string
  display: HostDisplay
  token: string
}

export type HostConnState =
  | { status: 'local' }
  | { status: 'connecting'; attempt: number }
  | { status: 'ready'; version: string; methods: ReadonlySet<string> | string[] }
  | { status: 'retrying'; attempt: number; error: string; nextInMs: number }
  | { status: 'failed'; error: string }
  | { status: 'closed' }

export type HostStatusView = {
  hostId: string | null
  label: string
  state: HostConnState
  methods: string[]
  /** 当前这台主机的标识与显示方式(本机时为默认值) */
  icon?: string
  display?: HostDisplay
}

/** 一句人话的连接状态 —— 断线态必须是**显式**的,不能拿缓存假装在线(设计文档十·UI 约束)。 */
export function describeHostState(s: HostConnState): { text: string; short: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  switch (s.status) {
    // 卡片标题已经写着「本机」了,副标题再写一遍等于没说。说点有用的:你现在没连任何远程主机。
    // short 留空:芯片上已经写着「本机」了,再补一个「本机」就是「本机 本机」。
    // text 是给设置面板那张卡片用的,那里需要把话说全。
    case 'local': return { text: '未连接任何远程主机 —— 当前看到的都是这台电脑上的内容', short: '', tone: 'idle' }
    case 'connecting': return { text: s.attempt > 1 ? `连接中(第 ${s.attempt} 次)` : '连接中…', short: '连接中', tone: 'warn' }
    case 'ready': return { text: `已连接 · ${s.version}`, short: '', tone: 'ok' }
    case 'retrying': return { text: `已断开,${Math.round(s.nextInMs / 1000)} 秒后重连 — ${s.error}`, short: '已断开', tone: 'bad' }
    case 'failed': return { text: `连接失败:${s.error}`, short: '连接失败', tone: 'bad' }
    case 'closed': return { text: '未连接', short: '未连接', tone: 'idle' }
  }
}
