import { describe, it, expect } from 'vitest'
import { codexSandboxApproval, codexDecision, codexGateReq, codexApprovalResponse, elicitationUnsupported } from './codexApproval'

describe('codexSandboxApproval', () => {
  it('maps modes to sandbox + interactive approvalPolicy', () => {
    expect(codexSandboxApproval('readonly', false)).toEqual({ sandbox: 'read-only', approvalPolicy: 'on-request' })
    expect(codexSandboxApproval('auto', false)).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    expect(codexSandboxApproval('full', false)).toEqual({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  })
  it('forces full access + never when forge MCP is injected', () => {
    expect(codexSandboxApproval('auto', true)).toEqual({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
    expect(codexSandboxApproval('readonly', true)).toEqual({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  })
})
describe('codexDecision', () => {
  it('maps allow/deny to v2 (item/*) decisions', () => {
    expect(codexDecision('item/commandExecution/requestApproval', true)).toBe('accept')
    expect(codexDecision('item/commandExecution/requestApproval', false)).toBe('decline')
    expect(codexDecision('item/fileChange/requestApproval', true)).toBe('accept')
  })
  it('maps allow/deny to v1 decisions for legacy methods', () => {
    expect(codexDecision('execCommandApproval', true)).toBe('approved')
    expect(codexDecision('applyPatchApproval', false)).toBe('denied')
  })
})

describe('codexGateReq', () => {
  it('★★把 itemId 带成 toolUseId —— 上层只有拿到它,才能把「自动放行」挂到那张工具卡上而不是发一条假回答', () => {
    expect(codexGateReq({ method: 'item/commandExecution/requestApproval', itemId: 'item_5', command: 'go vet ./...' }))
      .toEqual({ title: 'shell 请求执行', where: 'go vet ./...', toolUseId: 'item_5' })
  })
  it('文件类审批同样带 itemId', () => {
    expect(codexGateReq({ method: 'item/fileChange/requestApproval', itemId: 'item_7', paths: ['a.go', 'b.go'] }))
      .toEqual({ title: '文件 请求执行', where: 'a.go, b.go', toolUseId: 'item_7' })
  })
  it('★老的 v1 方法没有 itemId —— 只能不带,上层据此回落成发消息(不能悄悄放行)', () => {
    expect(codexGateReq({ method: 'execCommandApproval', command: 'ls' }).toolUseId).toBeUndefined()
  })
})

/**
 * 用户 2026-09-14 报:codex(逐字输出/app-server 通路)调用公司内部 MCP,里面有 python 执行,
 * 「也会询问权限,但是咱们 app 里也没有提示,我也不知道是否卡住」——光标一直在动,没有任何内容。
 *
 * 查下来是**回答格式错了**,不是没收到。codex 官方 schema(`codex app-server generate-json-schema`)
 * 对每一种服务端请求规定了不同的回答形状,而我们对所有审批一律回 `{decision}`、对不认识的一律回 `{}`。
 * 回答缺必填字段 → codex 反序列化失败 → 那次调用**永远悬着** → 这一轮永远不结束(所以光标还在动)。
 */
describe('codexApprovalResponse —— 每种请求的回答形状都不一样', () => {
  it('v2 的命令/文件审批:{decision: accept|decline}', () => {
    expect(codexApprovalResponse('item/commandExecution/requestApproval', true, {} as never))
      .toEqual({ decision: 'accept' })
    expect(codexApprovalResponse('item/fileChange/requestApproval', false, {} as never))
      .toEqual({ decision: 'decline' })
  })

  it('v1 的老方法:{decision: approved|denied}', () => {
    expect(codexApprovalResponse('execCommandApproval', true, {} as never)).toEqual({ decision: 'approved' })
    expect(codexApprovalResponse('applyPatchApproval', false, {} as never)).toEqual({ decision: 'denied' })
  })

  it('★★权限申请要的是 {permissions},不是 {decision} —— 这条我们一直回错,所以它一直悬着', () => {
    // schema: PermissionsRequestApprovalResponse 的 required 是 ["permissions"]。
    // RequestPermissionProfile 和 GrantedPermissionProfile 结构相同,所以「允许」= 原样授予。
    const asked = { network: { enabled: true }, fileSystem: { write: ['/tmp'] } }
    expect(codexApprovalResponse('item/permissions/requestApproval', true, { method: 'item/permissions/requestApproval', permissions: asked }))
      .toEqual({ permissions: asked, scope: 'turn' })
  })

  it('★拒绝权限 = 授予一个空档(不能省掉 permissions 字段,它是必填的)', () => {
    const r = codexApprovalResponse('item/permissions/requestApproval', false, { method: 'item/permissions/requestApproval', permissions: { network: { enabled: true } } })
    expect(r).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('★★MCP elicitation 要的是 {action},既不是 decision 也不是 permissions', () => {
    expect(codexApprovalResponse('mcpServer/elicitation/request', true, { method: 'mcpServer/elicitation/request' }))
      .toEqual({ action: 'accept' })
    expect(codexApprovalResponse('mcpServer/elicitation/request', false, { method: 'mcpServer/elicitation/request' }))
      .toEqual({ action: 'decline' })
  })
})

describe('elicitationUnsupported —— 要填表单的那种我们还答不了', () => {
  const base = { method: 'mcpServer/elicitation/request', serverName: 'inner-mcp', message: '允许执行 python?' }

  it('没有必填字段 → 能用「允许/拒绝」答,不算不支持', () => {
    expect(elicitationUnsupported({ ...base, mode: 'form', requestedSchema: { properties: {} } })).toBeNull()
    expect(elicitationUnsupported({ ...base, mode: 'form', requestedSchema: { properties: {}, required: [] } })).toBeNull()
  })

  it('url 模式能答(把地址摆给用户看,他自己去办)', () => {
    expect(elicitationUnsupported({ ...base, mode: 'url', url: 'https://x/auth' })).toBeNull()
  })

  it('★要填具体字段的表单 → 答不了,但必须**说出缺什么**并放行这一轮,不能干悬着', () => {
    const why = elicitationUnsupported({ ...base, mode: 'form', requestedSchema: { properties: { token: { type: 'string' } }, required: ['token'] } })
    expect(why).toContain('token')
  })
})

describe('codexGateReq —— 新增的两种也要有人话', () => {
  it('权限申请:说清是谁、要什么、为什么', () => {
    const r = codexGateReq({
      method: 'item/permissions/requestApproval', itemId: 'i1',
      reason: '要联网装依赖', permissions: { network: { enabled: true } },
    })
    expect(r.title).toContain('权限')
    expect(r.where).toContain('联网')
    expect(r.toolUseId).toBe('i1')
  })

  it('★MCP elicitation:必须带上是**哪个 MCP** 在问 —— 否则用户看到一句没头没尾的话', () => {
    const r = codexGateReq({ method: 'mcpServer/elicitation/request', serverName: 'inner-mcp', message: '允许执行 python?' })
    expect(r.title).toContain('inner-mcp')
    expect(r.where).toContain('允许执行 python?')
  })
})
