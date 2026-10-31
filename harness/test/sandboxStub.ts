// 测试用:不探测、不起代理的沙箱(R22)。级别 none 时 plan 原样返回无沙箱计划。
// 测 auto 不审批的用例另在配置里写 permissions.allowUnsandboxedAuto: true(seedUnsandboxedAuto)
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelOpts } from '../src/kernel/kernel'

export const NO_SANDBOX: NonNullable<KernelOpts['sandbox']> = Object.freeze({
  detect: () => ({ level: 'none' as const, missing: ['platform' as const] }),
  upstream: null,
})

/**
 * 写 dataDir/config.json,打开 permissions.allowUnsandboxedAuto:NO_SANDBOX 下的 auto 会话照 03 不审批命令。
 * rest 是 config.json 的其他段(如 plugins);rest.permissions 里的字段与它合并
 */
export function seedUnsandboxedAuto(dataDir: string, rest: Record<string, unknown> = {}): void {
  const permissions = { ...(rest.permissions as Record<string, unknown> | undefined), allowUnsandboxedAuto: true }
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ ...rest, permissions }))
}
