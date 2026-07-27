import { describe, it, expect } from 'vitest'
import { codexSandboxApproval, codexDecision } from './codexApproval'

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
