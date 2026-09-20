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
export const PERMISSIONS_METHOD = 'item/permissions/requestApproval'
export const ELICITATION_METHOD = 'mcpServer/elicitation/request'

/** 把权限档摊成人话。schema 里 fileSystem / network 都是可空的,两个都没有就是「没要什么」。 */
function describePermissions(p: unknown): string {
  const prof = (p ?? {}) as { network?: { enabled?: boolean | null } | null; fileSystem?: Record<string, unknown> | null }
  const parts: string[] = []
  if (prof.network?.enabled) parts.push('联网')
  const fs = prof.fileSystem
  if (fs) {
    const paths = [
      ...(Array.isArray(fs.read) ? (fs.read as string[]) : []),
      ...(Array.isArray(fs.write) ? (fs.write as string[]) : []),
    ]
    parts.push(paths.length ? `读写 ${paths.join(', ')}` : '额外的文件访问')
  }
  return parts.join(' + ')
}

/**
 * 这次审批**确定是只读**吗?
 *
 * ★★判据来自 codex 自己解析好的 `commandActions`(官方 schema:`read` | `listFiles` | `search`
 *  | `unknown`),**不是我们去猜命令字符串**。靠正则判断一条 shell 命令安不安全是安全工程里
 *  最经典的那个错 —— `rm` 藏在管道、变量、`$(...)` 后面就绕过去了。
 *
 * ★★★三条**失败即拦**的规矩,缺一条这个函数就变成安全漏洞:
 *  ① 字段不在 / 不是数组 → false。老版本 codex 不发这个字段,那时候一切照旧升门。
 *  ② 空数组 → false。「没有任何动作」不等于「只读」,它等于「没解析出来」。
 *  ③ 只要有**一项**不是那三种已知只读类型(包括 `unknown`)→ false。
 *    schema 自己写着这是 "best-effort parsed",`unknown` 的意思是「没认出来」,不是「安全」。
 */
const READ_ONLY_ACTIONS = new Set(['read', 'listFiles', 'search'])
export function codexReadOnly(r: CodexApprovalReq): boolean {
  const acts = r.commandActions
  if (!Array.isArray(acts) || acts.length === 0) return false
  return acts.every((a) => {
    const t = (a as { type?: unknown } | null)?.type
    return typeof t === 'string' && READ_ONLY_ACTIONS.has(t)
  })
}

export function codexGateReq(r: CodexApprovalReq): ConfirmReq {
  // ★MCP 的 elicitation:**必须说出是哪个 MCP 在问**。少了服务名,用户看到的就是一句没头没尾的
  //  「允许执行 python?」—— 他根本不知道这是谁弹的、该不该点。
  if (r.method === ELICITATION_METHOD) {
    const where = r.mode === 'url' && r.url ? `${r.message ?? ''}\n${r.url}` : (r.message ?? '')
    return { title: `MCP「${r.serverName ?? '未知服务'}」请求确认`, where, toolUseId: r.itemId }
  }
  if (r.method === PERMISSIONS_METHOD) {
    const want = describePermissions(r.permissions)
    return {
      title: '请求额外权限',
      where: [r.reason, want].filter(Boolean).join(' — ') || '(没有说明要什么)',
      toolUseId: r.itemId,
    }
  }
  return {
    title: `${r.command ? 'shell' : '文件'} 请求执行`,
    where: r.command ?? r.paths?.join(', '),
    toolUseId: r.itemId,
    readOnly: codexReadOnly(r),
  }
}

/**
 * 这次 elicitation 能不能用一句「允许 / 拒绝」答完?能就返回 null,不能就返回**缺什么**。
 *
 * ★MCP 的 elicitation 有两类:一类就是确认(没有必填字段),一类是让你填一张表(`requestedSchema.required`
 *  列了字段)。后者我们现在渲染不出表单 —— 但**绝不能因此就干悬着**:告诉用户缺哪几个字段、
 *  自动拒绝、让这一轮继续跑完,比让他盯着一个不动的光标强得多。
 */
export function elicitationUnsupported(r: CodexApprovalReq): string | null {
  if (r.method !== ELICITATION_METHOD) return null
  const required = r.requestedSchema?.required
  if (!Array.isArray(required) || required.length === 0) return null
  return `需要填写:${required.join('、')}`
}

/**
 * 一次审批/确认的**回答报文**。
 *
 * ★★★每种请求的回答形状都不一样,这是 codex 官方 schema 规定的
 *  (`codex app-server generate-json-schema --out <dir>`)。原来这里一律回 `{decision}`,于是
 *  `item/permissions/requestApproval` 一直回错(它的必填字段是 `permissions`),
 *  而 `mcpServer/elicitation/request` 压根没进这条路、被兜底回了个 `{}`。
 *  **回答缺必填字段不会报错,只会让 codex 反序列化失败,那次调用永远悬着** ——
 *  表现出来就是「光标一直在动,但没有任何内容」。2026-09-14 用户就是这么撞上的。
 */
export function codexApprovalResponse(method: string, allow: boolean, r: CodexApprovalReq): unknown {
  // PermissionsRequestApprovalResponse: { permissions: GrantedPermissionProfile, scope?: 'turn'|'session' }
  // ★RequestPermissionProfile 和 GrantedPermissionProfile 结构相同,所以「允许」= 把它要的原样给它;
  //  「拒绝」= 给一个空档(不能省掉这个字段,它是必填的)。
  if (method === PERMISSIONS_METHOD) {
    return { permissions: allow ? (r.permissions ?? {}) : {}, scope: 'turn' }
  }
  // McpServerElicitationRequestResponse: { action: 'accept'|'decline'|'cancel', content?: … }
  if (method === ELICITATION_METHOD) {
    return { action: allow ? 'accept' : 'decline' }
  }
  return { decision: codexDecision(method, allow) }
}

// Map an allow/deny decision to the approval method's expected enum. v2 methods (item/*) use
// accept/decline; the legacy v1 methods (execCommandApproval/applyPatchApproval) use approved/denied.
export function codexDecision(method: string, allow: boolean): string {
  const v2 = method.startsWith('item/')
  if (allow) return v2 ? 'accept' : 'approved'
  return v2 ? 'decline' : 'denied'
}
