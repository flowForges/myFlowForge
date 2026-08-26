// 纯 Set 运算搬去了 @shared/ui/expanded(手机端 import 的是同一份)。这里只留持久化 ——
// 它跟平台走(localStorage vs AsyncStorage,同步 vs 异步),搬不过去。
export { toggleExpanded, ensureExpanded } from '@shared/ui/expanded'

const KEY = 'forge.expandedWs'

export function loadExpanded(): string[] {
  try { const r = localStorage.getItem(KEY); return r ? (JSON.parse(r) as string[]) : [] } catch { return [] }
}
export function saveExpanded(ids: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(ids)) } catch { /* ignore */ }
}
