// 记忆蒸馏(distiller)用当前会话的 provider 执行 oneShot。蒸馏偏好一个便宜的轻量模型,
// 但传给 provider.chat 的 model id 必须对该 provider 合法。'haiku-4.5' 是 claude 专属别名
// (见 providers/claude.ts 的 CLI_MODEL_ALIAS);若把它传给 codex(ChatGPT 账号)/cursor 等会
// 触发 `The 'haiku-4.5' model is not supported ...` 400。
//
// 因此:只有 claude 会话用 haiku 别名蒸馏(便宜且合法);其它 provider 返回 undefined,
// 由调用方回退到会话自身的 model(其账号默认,恒合法)。
export function distillModelFor(providerId: string): string | undefined {
  return providerId === 'claude' ? 'haiku-4.5' : undefined
}
