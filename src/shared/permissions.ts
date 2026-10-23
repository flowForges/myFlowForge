// Unified agent permission modes — how much the coding agent may touch on its own. Because the app
// drives every CLI HEADLESSLY (no TTY, and no CLI-native per-op approval protocol is wired), true
// interactive "ask before each action" isn't reliable (it silently fails or deadlocks). So the modes
// map to each provider's SANDBOX SCOPE instead, which is headless-safe and never blocks:
//   readonly → read-only (reads + proposes, never writes)   [claude plan / codex read-only]
//   auto     → workspace-scoped auto edits, no network       [claude acceptEdits / codex workspace-write]  (default)
//   full     → unrestricted files + network                  [claude bypassPermissions / codex danger-full-access]
// Providers without a sandbox dimension (cursor/opencode/gemini) don't change behaviour across modes.
// Per-provider CLI flags live in src/main/agents/permissionArgs.ts —— ★deepseek(dsh) 是例外：
// 它的三档走环境变量 `DSH_PERMISSION_MODE`（read-only / workspace-write / danger-full-access），
// 不是命令行 flag，所以在 providers/deepseek.ts 的 spawn env 里给，不进 permissionArgs。

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
export const PERMISSION_AWARE_PROVIDERS = ['claude', 'codex', 'qoder', 'antigravity', 'deepseek'] as const

/**
 * 聊天走 ACP 的 provider(agents/acp/acpProvider.ts):工具调用经 session/request_permission 逐个升门,
 * 门由 app 答,所以权限档(含运行中提权)和 claude 一样能兑现。
 * ★前提是这个 CLI 真讲得了 ACP。`acpUnavailable` = 本次运行里它的握手**确实失败过**(主进程按 bin 记着,
 *  经 ProviderInfo.acpUnavailable 带到渲染端)—— 那时聊天回落到 run(),行为和以前完全一样:无门、全放行。
 *  没试过按「讲得了」算:真讲不了时那一轮回落,PATH shim 仍在(见 providerUsesCommandShim)。
 * ★kimi 不在这里:选了具体模型时它的聊天直接走 run()(`kimi acp` 不吃 --model),那时没有门。
 */
export const ACP_GATED_PROVIDERS = ['gemini', 'qwen', 'copilot'] as const
const acpGated = (providerId: string, acpUnavailable: boolean) =>
  !acpUnavailable && (ACP_GATED_PROVIDERS as readonly string[]).includes(providerId)

export function providerSupportsPermissions(providerId: string, acpUnavailable = false): boolean {
  return (PERMISSION_AWARE_PROVIDERS as readonly string[]).includes(providerId) || acpGated(providerId, acpUnavailable)
}

/**
 * 「只读」这一档是硬限制的 provider(启动参数 / 沙箱 / 工具白名单,见 agents/permissionArgs.ts 和各 provider):
 * claude plan + 门、codex read-only 沙箱、qoder dont_ask + --tools、pi --tools、opencode forge-readonly agent、trae plan + --disallowed-tool、kimi 只读 agent 文件。
 * ACP 那几家(gemini / qwen / copilot)只在 ACP 门还在时算(见 ACP_GATED_PROVIDERS)。
 * ★antigravity 不在:工作区内写文件无头下自动放行,--mode plan 只是提示词前缀。
 * ★deepseek 不在:dsh 的 workflow 工具能绕过 DSH_PERMISSION_MODE=read-only(见 council.ts 的排除说明)。
 *  它本来就在 PERMISSION_AWARE_PROVIDERS 里,不走预授权门,所以去掉它不改变行为。
 * ★和 PERMISSION_AWARE_PROVIDERS 不是一回事:pi / opencode / trae / kimi 只有只读档有意义,自动 / 完全照旧。
 */
export const READONLY_ENFORCED_PROVIDERS = ['claude', 'codex', 'qoder', 'pi', 'opencode', 'trae', 'kimi'] as const
export function providerEnforcesReadonly(providerId: string, acpUnavailable = false): boolean {
  return (READONLY_ENFORCED_PROVIDERS as readonly string[]).includes(providerId) || acpGated(providerId, acpUnavailable)
}

// 哪些 provider 会为每个操作升起确认门。只有它们能在【运行中】兑现权限档的【提升】—— 门是 app 答的,
// 所以门升起来时重读一次档、答 allow,就等于半途提权(见 ipc/handlers.ts 的 toolConfirm)。
// 其余 provider 的档位纯粹是启动时的沙箱参数,进程一起来就钉死:codex 的 approval_policy 恒 "never"
// (交互策略会死锁),qoder/antigravity 连逐操作协议都没有。
// codex 的 app-server transport 其实也有门,但默认关、且不是每个操作都升门 —— 这里保守地不算进来:
// 多提示一句「下一条消息生效」顶多是啰嗦,漏提示才会让用户以为功能坏了。
// ★这张表只放**原生**就有门的(不依赖握手结果);ACP 那几家见 ACP_GATED_PROVIDERS。
export const OPERATION_GATED_PROVIDERS = ['claude'] as const
export function providerGatesEachOperation(providerId: string, acpUnavailable = false): boolean {
  return (OPERATION_GATED_PROVIDERS as readonly string[]).includes(providerId) || acpGated(providerId, acpUnavailable)
}

/**
 * 这一轮要不要装 PATH shim(ipc/handlers.ts 的授权中枢)。
 * ★★只跟「原生有门」走,**不**跟 ACP 走:ACP 握手要到 spawn 之后才知道成没成,失败了同一轮会回落到
 *  run() —— copilot 那时是 `--allow-all-tools`,没有 shim 就等于 `git push` / `rm` 无人过问。
 *  ACP 子进程自己会把 shim 从 env 里拆掉(acpProvider.ts → stripShimEnv),所以不会问两遍。
 */
export function providerUsesCommandShim(providerId: string): boolean {
  return !(OPERATION_GATED_PROVIDERS as readonly string[]).includes(providerId)
}

// 在一轮【正在跑】的时候切档,这次切换能不能当场兑现?
// 只有「会升门的 provider」+「切到完全访问」这一种组合可以。收紧(切到只读/自动)一律不行:
// 已经起来的那个进程的沙箱改不了,而门只能用来【放行】,没法反过来收回已经授予的范围。
// ★`startedMode` = 这一轮起手时的档。ACP 那几家以「只读审阅」起手时,plan 档参数和「非只读一律拒」的
//  包装(acpProvider.ts)都是起手那一刻钉死的 —— 半途切到完全访问也放不开,所以和别的 provider 一样算不兑现。
export function permissionAppliesMidRun(providerId: string, mode: PermissionMode, acpUnavailable = false, startedMode?: PermissionMode): boolean {
  if (mode !== 'full') return false
  if ((OPERATION_GATED_PROVIDERS as readonly string[]).includes(providerId)) return true
  return acpGated(providerId, acpUnavailable) && startedMode !== 'readonly'
}
