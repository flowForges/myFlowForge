import type { ChatSession } from '@shared/types'

// 左侧会话行标识：导入（只读外部会话）/ 续（基于导入历史的可写续聊）/ 新（本 app 原生会话）。
export function sessionBadge(s: ChatSession): { kind: 'import' | 'cont' | 'new'; label: string } {
  if (s.readonly && s.external) return { kind: 'import', label: '导入' }
  if (s.continuedFrom) return { kind: 'cont', label: '续' }
  return { kind: 'new', label: '新' }
}
