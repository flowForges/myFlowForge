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
    // Antigravity 没有逐操作审批协议(--help 只有 --mode 与 --dangerously-skip-permissions),无头下由策略
    // 决定:工作区内文件自动放行、shell 默认软拒绝。三档就映射到这两个开关,不去代改它的 settings.json。
    case 'antigravity':
      if (mode === 'readonly') return ['--mode', 'plan']
      if (mode === 'full') return ['--dangerously-skip-permissions']
      return ['--mode', 'accept-edits']
    // ★qoder readonly:dont_ask = 无头下凡是要问的一律拒(不挂起);--tools 把内置工具收窄到只读三件
    //  (没列出的直接不存在),再显式拒 Edit/Write/Bash —— default 模式会认用户 settings 里的 allow 规则和
    //  「看起来只读」的 Bash,不够。--tools 是可变参,调用方必须让后面紧跟别的 --选项(prompt 已在 -p 后)。
    //  依据 research.md §1(docs.qoder.com/en/cli/permissions + 本机 qodercli 1.0.29 --help),未真机探针。
    case 'qoder':
      if (mode === 'readonly') return ['--permission-mode', 'dont_ask', '--tools', 'Read', 'Grep', 'Glob',
        '--disallowed-tools', 'Edit', '--disallowed-tools', 'Write', '--disallowed-tools', 'Bash']
      if (mode === 'full') return ['--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions']
      return ['--permission-mode', 'accept_edits']
    default:
      return []   // cursor / opencode / gemini: no sandbox dimension
  }
}
