// ★这两个纯 Set 运算被**两端 import 同一份**:Electron 渲染层的左侧栏、手机端的会话列表分组。
//  持久化那两个函数**没有**搬过来 —— 存储介质不同(localStorage / AsyncStorage),
//  而且一个是同步一个是异步。同一个路子:@shared/chat/unread。

export function toggleExpanded(set: Set<string>, id: string): Set<string> {
  const next = new Set(set)
  if (next.has(id)) next.delete(id); else next.add(id)
  return next
}
// Add without toggling — used when ENTERING a workspace (create / navigate) so it opens expanded with
// its session list visible, rather than requiring a second click. Returns the same set if already open
// (lets callers skip a redundant state update / persist).
export function ensureExpanded(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set
  const next = new Set(set); next.add(id); return next
}
