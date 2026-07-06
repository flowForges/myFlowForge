import { describe, it, expect } from 'vitest'
import { permissionArgs } from './permissionArgs'

describe('permissionArgs', () => {
  it('claude → --permission-mode plan/acceptEdits/bypassPermissions', () => {
    expect(permissionArgs('claude', 'readonly')).toEqual(['--permission-mode', 'plan'])
    expect(permissionArgs('claude', 'auto')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(permissionArgs('claude', 'full')).toEqual(['--permission-mode', 'bypassPermissions'])
  })
  it('codex → -c sandbox_mode + approval_policy=never (never blocks headlessly)', () => {
    expect(permissionArgs('codex', 'readonly')).toEqual(['-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"'])
    expect(permissionArgs('codex', 'auto')).toEqual(['-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="never"'])
    expect(permissionArgs('codex', 'full')).toEqual(['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"'])
  })
  it('qoder → claude-compatible --permission-mode, full adds --dangerously-skip-permissions', () => {
    expect(permissionArgs('qoder', 'readonly')).toEqual(['--permission-mode', 'default'])
    expect(permissionArgs('qoder', 'auto')).toEqual(['--permission-mode', 'accept_edits'])
    expect(permissionArgs('qoder', 'full')).toEqual(['--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions'])
  })
  it('providers without a sandbox dimension get no permission flags', () => {
    expect(permissionArgs('cursor', 'readonly')).toEqual([])
    expect(permissionArgs('opencode', 'full')).toEqual([])
    expect(permissionArgs('gemini', 'auto')).toEqual([])
  })
  it('unknown provider or undefined mode → empty (safe no-op)', () => {
    expect(permissionArgs('whatever', 'auto')).toEqual([])
    expect(permissionArgs('claude', undefined)).toEqual([])
  })
})
