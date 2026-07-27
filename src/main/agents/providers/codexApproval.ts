import type { PermissionMode } from '@shared/permissions'

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

// Map an allow/deny decision to the approval method's expected enum. v2 methods (item/*) use
// accept/decline; the legacy v1 methods (execCommandApproval/applyPatchApproval) use approved/denied.
export function codexDecision(method: string, allow: boolean): string {
  const v2 = method.startsWith('item/')
  if (allow) return v2 ? 'accept' : 'approved'
  return v2 ? 'decline' : 'denied'
}
