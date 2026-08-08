import type { SessionsFile } from '@shared/types'
import { sessionLastMessageMtime } from './chatStore'

// 会话列表出 IPC 前统一附加派生字段。
//
// `lastMessageAt`(该会话消息文件的 mtime)不写回 sessions.json —— 存储保持干净,每次读时按文件重新派生。
// 但「派生」必须发生在**每一个** IPC 出口上,不能只在 session:list 那一处:侧栏的会话列表既会从 sessionList
// 拉,也会被 sessions:changed 广播和 sessionNew/Switch/Close/Rename 的返回值整个替换掉。少补一个出口,那条
// 路径送出去的会话就没有 lastMessageAt,侧栏回落到 createdAt —— 表现就是「时间显示的是会话创建时间」。
// 而切换会话是高频操作,于是几乎总是看到创建时间。
export function withLastMessageAt(
  wsPath: string,
  file: SessionsFile,
  mtime: (wsPath: string, sessionId: string) => number | undefined = sessionLastMessageMtime,
): SessionsFile {
  return {
    ...file,
    sessions: file.sessions.map(s => ({ ...s, lastMessageAt: mtime(wsPath, s.id) ?? s.createdAt })),
  }
}
