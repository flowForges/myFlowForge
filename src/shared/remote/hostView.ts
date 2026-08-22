/** 渲染层看到的一台远程主机。★不含 token —— 凭据没有任何理由进渲染进程。 */
export type RemoteHostView = {
  id: string
  label: string
  kind: 'direct' | 'ssh'
  address: string
  sshTarget: string
  token: string
  lastConnectedAt: number
}

export type HostInput = {
  id?: string
  label: string
  kind: 'direct' | 'ssh'
  address: string
  sshTarget: string
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
}

/** 一句人话的连接状态 —— 断线态必须是**显式**的,不能拿缓存假装在线(设计文档十·UI 约束)。 */
export function describeHostState(s: HostConnState): { text: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  switch (s.status) {
    case 'local': return { text: '本机', tone: 'idle' }
    case 'connecting': return { text: s.attempt > 1 ? `连接中(第 ${s.attempt} 次)` : '连接中…', tone: 'warn' }
    case 'ready': return { text: `已连接 · ${s.version}`, tone: 'ok' }
    case 'retrying': return { text: `已断开,${Math.round(s.nextInMs / 1000)} 秒后重连 — ${s.error}`, tone: 'bad' }
    case 'failed': return { text: `连接失败:${s.error}`, tone: 'bad' }
    case 'closed': return { text: '未连接', tone: 'idle' }
  }
}
