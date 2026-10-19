import type { ChatEvent } from '@shared/types'

/** 每个工作区挂着的对话门:confirm(批准执行)/ input(模型提问)各一组 id。侧栏状态徽标用。 */
export type ChatGateMap = Map<string, { confirm: Set<string>; input: Set<string> }>

/**
 * 把一条 ChatEvent 折进门计数。★先看事件类型,和门无关的(流式 delta 占绝大多数)直接原样返回 prev ——
 * 原来每个 delta 都先 new 一个 Map 再 new 两个 Set,最后才发现没事可做,纯属给 GC 添活。
 * 加一个已在的 id / 删一个本来就没有的 id 同样算「没变」,不换引用,侧栏也就不跟着重算。
 */
export function applyChatGateEvent(prev: ChatGateMap, e: ChatEvent): ChatGateMap {
  let field: 'confirm' | 'input'
  let add: boolean
  if (e.type === 'confirm-request') { field = 'confirm'; add = true }
  else if (e.type === 'confirm-resolved') { field = 'confirm'; add = false }
  else if (e.type === 'ask-request') { field = 'input'; add = true }
  else if (e.type === 'ask-resolved') { field = 'input'; add = false }
  else return prev
  const cur = prev.get(e.workspacePath)
  if ((cur?.[field].has(e.id) ?? false) === add) return prev
  const set = new Set(cur?.[field])
  if (add) set.add(e.id); else set.delete(e.id)
  const n = new Map(prev)
  n.set(e.workspacePath, {
    confirm: field === 'confirm' ? set : (cur?.confirm ?? new Set<string>()),
    input: field === 'input' ? set : (cur?.input ?? new Set<string>()),
  })
  return n
}
