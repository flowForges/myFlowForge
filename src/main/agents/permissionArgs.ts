import type { PermissionMode } from '@shared/permissions'

// Map a unified permission mode to the CLI flags for a given provider. Returns [] when the provider
// has no sandbox/permission dimension (cursor/opencode/gemini) or when no mode is set — callers splice
// the result into their arg array, so [] is a safe no-op that preserves the provider's own defaults.
//
// IMPORTANT (headless safety): codex's approval_policy is ALWAYS "never" — an interactive policy would
// deadlock (stdin is ignored and no approval event is parsed). The tier is expressed purely via
// sandbox_mode. Likewise claude/qoder use non-interactive permission modes only. See permissions.ts.
export function permissionArgs(providerId: string, mode: PermissionMode | undefined): string[] {
  if (!mode) return []
  switch (providerId) {
    case 'claude':
      return ['--permission-mode', mode === 'readonly' ? 'plan' : mode === 'full' ? 'bypassPermissions' : 'acceptEdits']
    case 'codex': {
      const sandbox = mode === 'readonly' ? 'read-only' : mode === 'full' ? 'danger-full-access' : 'workspace-write'
      // Use -c overrides (NOT -s): `codex exec resume` rejects -s/--sandbox but accepts -c config.
      return ['-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"']
    }
    case 'qoder':
      if (mode === 'readonly') return ['--permission-mode', 'default']
      if (mode === 'full') return ['--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions']
      return ['--permission-mode', 'accept_edits']
    default:
      return []   // cursor / opencode / gemini: no sandbox dimension
  }
}
