// Unified agent permission modes — how much the coding agent may touch on its own. Because the app
// drives every CLI HEADLESSLY (no TTY, and no CLI-native per-op approval protocol is wired), true
// interactive "ask before each action" isn't reliable (it silently fails or deadlocks). So the modes
// map to each provider's SANDBOX SCOPE instead, which is headless-safe and never blocks:
//   readonly → read-only (reads + proposes, never writes)   [claude plan / codex read-only]
//   auto     → workspace-scoped auto edits, no network       [claude acceptEdits / codex workspace-write]  (default)
//   full     → unrestricted files + network                  [claude bypassPermissions / codex danger-full-access]
// Providers without a sandbox dimension (cursor/opencode/gemini) don't change behaviour across modes.
// Per-provider CLI flags live in src/main/agents/permissionArgs.ts.

export type PermissionMode = 'readonly' | 'auto' | 'full'

export interface PermissionModeSpec {
  id: PermissionMode
  label: string
  desc: string
}

// Order = most cautious → most permissive (how the picker lists them).
export const PERMISSION_MODES: PermissionModeSpec[] = [
  { id: 'readonly', label: '只读审阅', desc: '只读代码并给出方案,不修改任何文件' },
  { id: 'auto', label: '自动(工作区)', desc: '自动修改工作区内的文件,不联网、不碰工作区外' },
  { id: 'full', label: '完全访问', desc: '不受限地访问文件与网络' },
]

// Default matches the app's prior behaviour (workspace-scoped auto edits).
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto'

export function permissionModeLabel(mode: PermissionMode): string {
  return PERMISSION_MODES.find(m => m.id === mode)?.label ?? mode
}

export function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'readonly' || v === 'auto' || v === 'full'
}

// Providers whose CLI exposes a real sandbox/permission dimension. Others ignore the mode (their
// behaviour is fixed), which the UI surfaces so the picker isn't misleading.
export const PERMISSION_AWARE_PROVIDERS = ['claude', 'codex', 'qoder'] as const
export function providerSupportsPermissions(providerId: string): boolean {
  return (PERMISSION_AWARE_PROVIDERS as readonly string[]).includes(providerId)
}
