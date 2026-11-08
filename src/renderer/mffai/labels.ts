// 稳定代码 → 中文标签(08 §6.3)。只翻译状态;原因代码原样显示在 CodeChip 里。不认识的代码原样返回。

const LABELS = {
  mcpState: {
    starting: '启动中', running: '运行中', stopping: '停止中', stopped: '已停止', refused: '已拒绝', problem: '有问题',
    server_failed: '服务失败', needs_sandbox: '需要沙箱', needs_config: '需要配置', integrity_failed: '校验失败', disabled: '已停用',
  },
  channelState: {
    starting: '启动中', online: '在线', reconnecting: '重连中', unauthorized: '令牌无效', conflict: '冲突',
    no_token: '未设令牌', disabled: '已停用', secrets_unavailable: '凭据不可用',
  },
  runStatus: { ok: '完成', failed: '失败', cancelled: '已取消', timeout: '超时', stalled: '卡住', interrupted: '中断' },
  level: { full: '完整', partial: '部分', none: '未隔离' },
  isolation: { own: '自带隔离', wrapped: '沙箱包裹', none: '未隔离' },
  accountState: { ok: '可用', needs_login: '需要重新登录', not_authorized: '未授权套餐使用', quota_exhausted: '额度用尽', error: '出错' },
  origin: { app: '本机', im: 'IM 渠道', schedule: '定时', acp: '编辑器' },
} as const satisfies Record<string, Record<string, string>>

export type LabelKind = keyof typeof LABELS
export const LABEL_KINDS = Object.keys(LABELS) as LabelKind[]

export function label(kind: LabelKind, code: string): string {
  const t: Record<string, string> = LABELS[kind]
  return Object.hasOwn(t, code) ? t[code] : code
}
