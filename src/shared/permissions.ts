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
export const PERMISSION_AWARE_PROVIDERS = ['claude', 'codex', 'qoder', 'antigravity'] as const
export function providerSupportsPermissions(providerId: string): boolean {
  return (PERMISSION_AWARE_PROVIDERS as readonly string[]).includes(providerId)
}

// 哪些 provider 会为每个操作升起确认门。只有它们能在【运行中】兑现权限档的【提升】—— 门是 app 答的,
// 所以门升起来时重读一次档、答 allow,就等于半途提权(见 ipc/handlers.ts 的 toolConfirm)。
// 其余 provider 的档位纯粹是启动时的沙箱参数,进程一起来就钉死:codex 的 approval_policy 恒 "never"
// (交互策略会死锁),qoder/antigravity 连逐操作协议都没有。
// codex 的 app-server transport 其实也有门,但默认关、且不是每个操作都升门 —— 这里保守地不算进来:
// 多提示一句「下一条消息生效」顶多是啰嗦,漏提示才会让用户以为功能坏了。
export const OPERATION_GATED_PROVIDERS = ['claude'] as const
export function providerGatesEachOperation(providerId: string): boolean {
  return (OPERATION_GATED_PROVIDERS as readonly string[]).includes(providerId)
}

// 在一轮【正在跑】的时候切档,这次切换能不能当场兑现?
// 只有「会升门的 provider」+「切到完全访问」这一种组合可以。收紧(切到只读/自动)一律不行:
// 已经起来的那个进程的沙箱改不了,而门只能用来【放行】,没法反过来收回已经授予的范围。
export function permissionAppliesMidRun(providerId: string, mode: PermissionMode): boolean {
  return mode === 'full' && providerGatesEachOperation(providerId)
}
