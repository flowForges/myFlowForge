// 测试用:不探测、不起代理的沙箱(R22)。级别 none 时 plan 原样返回无沙箱计划。
// 测 auto 不审批的用例另在配置里写 permissions.allowUnsandboxedAuto: true(Task 11 接上权限门之后才需要)
import type { KernelOpts } from '../src/kernel/kernel'

export const NO_SANDBOX: NonNullable<KernelOpts['sandbox']> = Object.freeze({
  detect: () => ({ level: 'none' as const, missing: ['platform' as const] }),
  upstream: null,
})
