import type { PermissionMode } from '@shared/permissions'
import type { ConfirmReq } from '../types'
import type { CodexApprovalReq } from './codexAppServer'

// Map the unified permission档 to codex app-server thread sandbox + approval policy. When forge MCP is
// injected, codex only runs MCP tools under danger-full-access, and approvals would block them — so force
// full/never (the chat orchestrator delegates real work to separately-sandboxed sub-agents), mirroring the
// existing exec-path behavior in codex.ts chat().
export function codexSandboxApproval(mode: PermissionMode, forge: boolean): { sandbox: string; approvalPolicy: string } {
  if (forge) return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  if (mode === 'readonly') return { sandbox: 'read-only', approvalPolicy: 'on-request' }
  if (mode === 'full') return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
  return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
}

/**
 * 一次 codex 审批请求 → 一道确认门。
 *
 * ★★写成一个共用函数,是因为 codex 有**两个**调用方(run() 和 chat()),而它们原来各抄了一份门的
 *  构造。2026-07 就在这上面栽过一次(见 [[trap-two-call-sites-run-vs-chat]]:只改一处 = 工作流修好了
 *  聊天照旧坏)。`toolUseId` 这个字段一旦漏在任何一处,那条路上的「自动放行」就会退化成往对话流里
 *  插一条带着原样 shell 命令的假「系统回答」。两边都从这里拿,就不存在只改一处的可能。
 */
export function codexGateReq(r: CodexApprovalReq): ConfirmReq {
  return {
    title: `${r.command ? 'shell' : '文件'} 请求执行`,
    where: r.command ?? r.paths?.join(', '),
    toolUseId: r.itemId,
  }
}

// Map an allow/deny decision to the approval method's expected enum. v2 methods (item/*) use
// accept/decline; the legacy v1 methods (execCommandApproval/applyPatchApproval) use approved/denied.
export function codexDecision(method: string, allow: boolean): string {
  const v2 = method.startsWith('item/')
  if (allow) return v2 ? 'accept' : 'approved'
  return v2 ? 'decline' : 'denied'
}
