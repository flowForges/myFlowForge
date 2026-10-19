// 「这个 bin 讲不讲得了 ACP」—— 本次 app 运行期间记住的握手结果(按 bin / 命令记,不落盘)。
//
// ★两个用处:
//  ① chatWithAcpFallback:已知讲不了 → 直接走回落,不再每轮白等一次握手(不认 --acp 的老版本可能要等满超时)。
//  ② 权限档 / 一次性授权卡:握手成功过或还没试过 → 按「有逐操作门」算;已知讲不了 → 和以前一样(无门、全放行)。
// ★只记本次运行:用户升级了 CLI,重启 app 就会重新试。

const known = new Map<string, boolean>()

export function recordAcpHandshake(bin: string, ok: boolean): void { known.set(bin, ok) }

/** 只有**确实失败过**才算不可用;没试过 = undefined = 不算。 */
export function acpKnownUnavailable(bin: string | undefined): boolean {
  return !!bin && known.get(bin) === false
}

/** 给 detect 结果补上 `acpUnavailable`(渲染端据此决定权限档是否可用)。不进 detect 缓存,每次现取。 */
export function withAcpAvailability<T extends { id: string }>(list: T[], registry: Record<string, { bin?: string } | undefined>): (T & { acpUnavailable?: boolean })[] {
  return list.map((p) => acpKnownUnavailable(registry[p.id]?.bin) ? { ...p, acpUnavailable: true } : p)
}

/** 测试用。 */
export function resetAcpAvailability(): void { known.clear() }
