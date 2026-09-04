/**
 * MCP 面板在主进程和渲染层之间传的形状。
 *
 * ★放 shared 是因为**三端都要用**:桌面端的面板、手机端的只读列表、以及主进程的 handler。
 *  抄三份的话,哪天字段改了会有一端静默显示成空白 —— 而这一层恰恰全是「读不出来就是一片空」的东西。
 */
export type McpAuthState = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unsupported' | 'unknown'

export interface McpServerView {
  name: string
  target: string
  auth: McpAuthState
  /** CLI 原话。上面那个枚举是我们的映射,映射错了至少这里还有真话。 */
  detail: string
}

export interface McpCapsView {
  mcp: boolean
  list: boolean
  login: boolean
  logout: boolean
  json: boolean
  noBrowser: boolean
}

export interface McpProviderView {
  providerId: string
  displayName: string
  caps: McpCapsView
  servers: McpServerView[]
  /** 这个 provider 单独出错(超时、CLI 报错)。★逐个容错:一台超时不该把整块面板变成一句报错。 */
  error: string | null
}

export interface McpLoginStarted {
  id: string
  url: string | null
  needsPaste: boolean
  outcome: 'ok' | 'fail' | null
  text: string
}

/** 状态 → 中文。★`unknown` 说的是「没看懂 CLI 那句话」,不是「没配」—— 两者不能混。 */
export const MCP_AUTH_LABEL: Record<McpAuthState, string> = {
  connected: '已连接',
  'needs-auth': '待授权',
  failed: '连不上',
  pending: '待批准',
  unsupported: '无需授权',
  unknown: '状态未知',
}
