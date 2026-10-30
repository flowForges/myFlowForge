// ChatGPT 套餐共享错误码表(spec §6.4)与令牌端点错误码(spec §9)
import { retryAfterMs, toModelError } from '../../lib/models/http'
import type { ModelError } from '../../lib/models/types'

/** 刷新令牌不可再用 → 需要重新登录 */
export const RELOGIN_CODES = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
])
/** 授权上下文不允许使用套餐 → 账号状态 not_authorized */
export const NOT_AUTHORIZED_CODES = new Set(['chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'])

const CODE_IN_TEXT = /(?:subscription_sharing_|chatpass_v2_)[a-z0-9_]+/

/** 从错误体取机器码:{error:{code,param}} / {error:"code"}(OAuth)/ {detail:{code}} / {detail:"…code…"} */
export function errorCodeOf(bodyText: string): { code?: string; param?: string } {
  let j: Record<string, unknown>
  try {
    j = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return {}
  }
  if (!j || typeof j !== 'object') return {}
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const err = j.error
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const code = str(e.code) ?? str(e.type)
    if (code) return { code, param: str(e.param) }
  }
  if (str(err)) return { code: str(err) }
  const d = j.detail
  if (d && typeof d === 'object') {
    const e = d as Record<string, unknown>
    return { code: str(e.code), param: str(e.param) }
  }
  if (typeof d === 'string') return { code: d.match(CODE_IN_TEXT)?.[0] }
  return {}
}

/** 已知码 → ModelError;未知码返回 undefined */
export function mapChatgptCode(code: string | undefined, message: string, param?: string): ModelError | undefined {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return { kind: 'quota', message, retryable: false }
    case 'subscription_sharing_user_not_eligible':
      return { kind: 'restricted', message, retryable: false }
    case 'subscription_sharing_unsupported_capability':
      return { kind: 'bad_request', message: param ? `${message} (${param})` : message, retryable: false }
    case 'subscription_sharing_route_not_supported':
      return { kind: 'bad_request', message, retryable: false }
    case 'subscription_sharing_invalid_user':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return { kind: 'auth', message, retryable: false }
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return { kind: 'unavailable', message, retryable: true }
  }
  return undefined
}

/** 开流前的 HTTP 错误 */
export function mapChatgptError(status: number, bodyText: string, headers?: Headers): ModelError {
  const base = toModelError(status, bodyText, headers)
  const { code, param } = errorCodeOf(bodyText)
  const known = mapChatgptCode(code, base.message, param)
  if (known) {
    const after = known.retryable ? retryAfterMs(headers) : undefined
    return after !== undefined ? { ...known, retryAfterMs: after } : known
  }
  // 403 无已知码:区域等策略拒绝,不是登录问题
  if (status === 403) return { kind: 'restricted', message: base.message, retryable: false }
  return base
}
