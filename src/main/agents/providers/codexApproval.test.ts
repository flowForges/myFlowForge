import { describe, it, expect } from 'vitest'
import { codexSandboxApproval, codexDecision, codexGateReq } from './codexApproval'

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
