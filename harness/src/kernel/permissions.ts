// 05 spec §4、§6:config.json 的 permissions 段。内核独占(插件不能写),
// 加载时宽松(坏规则不能让内核起不来),设置时严格(坏规则不落盘)
import { DEFAULT_NETWORK_ALLOW, parseRule, runTests, type MatchCtx, type Rule, type RuleError, type RuleSpec } from '../lib/permissions/rules'
import type { PermissionsConfig, SandboxStatus } from '../protocol/index'
import type { KernelConfig } from './config'

export type { PermissionsConfig }

/** 解析规则用例的上下文:cwd 由 runTests 换成假 cwd */
export type ParseCtx = Omit<MatchCtx, 'cwd'>

export interface ParsedPermissions {
  /** 生效的配置(加载时丢掉的规则 / 网络条目不在里面) */
  config: PermissionsConfig
  /** config.rules 编译后的规则,顺序相同 */
  rules: Rule[]
  /** index 指原始列表里的位置;结构错误(类型不对)index 为 -1,rule 是字段名 */
  errors: RuleError[]
}

/** Task 9 之前内核报告的沙箱状态 */
export const SANDBOX_STUB: SandboxStatus = { level: 'none', missing: ['platform'], autoDegraded: false }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** 网络白名单条目(Task 5 换成真正的校验) */
const validNetworkEntry = (e: unknown): e is string => typeof e === 'string' && e.trim() !== ''

/**
 * 解析并给出全部错误。结构不对的字段一律落到收紧的默认值(沙箱开、回环关、auto 不越过沙箱、白名单为空);
 * 能解析的 deny 即使用例失败也保留(收紧总是安全的),其余无效项丢掉
 */
function analyze(raw: unknown, ctx: ParseCtx): ParsedPermissions {
  const errors: RuleError[] = []
  const shape = (field: string) => errors.push({ index: -1, rule: field, reason: 'syntax' })
  let root: Record<string, unknown> = {}
  if (isObject(raw)) root = raw
  else if (raw !== undefined) shape('permissions')

  const specs: RuleSpec[] = []
  const rules: Rule[] = []
  let rawRules: unknown[] = []
  if (Array.isArray(root.rules)) rawRules = root.rules
  else if (root.rules !== undefined) shape('rules')
  const testCtx: MatchCtx = { ...ctx, cwd: '' } // runTests 自己换成 /__cwd__
  rawRules.forEach((x, i) => {
    if (!isObject(x)) return errors.push({ index: i, rule: typeof x === 'string' ? x : '', reason: 'syntax' })
    const text = typeof x.rule === 'string' ? x.rule : ''
    // 只留认识的字段;类型由 parseRule 校验
    const spec = { effect: x.effect, rule: x.rule, ...(x.match !== undefined && { match: x.match }), ...(x.noMatch !== undefined && { noMatch: x.noMatch }) } as RuleSpec
    const r = parseRule(spec, i)
    if ('reason' in r) return errors.push({ ...r, rule: text })
    const failed = runTests(r, testCtx, i)
    if (failed) errors.push(failed)
    if (failed && r.effect !== 'deny') return
    specs.push(spec)
    rules.push(r)
  })

  let network: Record<string, unknown> = {}
  let networkBad = false
  if (isObject(root.network)) network = root.network
  else if (root.network !== undefined) {
    shape('network')
    networkBad = true // 收紧:不退回默认白名单
  }
  let allow: string[] = []
  if (networkBad) allow = []
  else if (network.allow === undefined) allow = [...DEFAULT_NETWORK_ALLOW]
  else if (!Array.isArray(network.allow)) shape('network.allow')
  else
    network.allow.forEach((e, i) => {
      if (validNetworkEntry(e)) allow.push(e)
      else errors.push({ index: i, rule: String(e), reason: 'network' })
    })

  let sandbox: Record<string, unknown> = {}
  if (isObject(root.sandbox)) sandbox = root.sandbox
  else if (root.sandbox !== undefined) shape('sandbox')
  const flag = (v: unknown, field: string, fallback: boolean) => {
    if (typeof v === 'boolean') return v
    if (v !== undefined) shape(field)
    return fallback
  }
  const config: PermissionsConfig = {
    rules: specs,
    network: { allow },
    sandbox: { enabled: flag(sandbox.enabled, 'sandbox.enabled', true), allowLoopback: flag(sandbox.allowLoopback, 'sandbox.allowLoopback', false) },
    allowUnsandboxedAuto: flag(root.allowUnsandboxedAuto, 'allowUnsandboxedAuto', false),
  }
  return { config, rules, errors }
}

/** 加载模式(spec §6):保留能解析的 deny,丢掉无效 / 用例失败的 ask、allow 与无效网络条目;错误都记下 */
export function parsePermissions(raw: unknown, ctx: ParseCtx): ParsedPermissions {
  return analyze(raw, ctx)
}

/** 严格模式(permissions.set 用):任何一条错误都整份拒绝;缺的部分取默认值 */
export function validatePermissions(raw: unknown, ctx: ParseCtx): { ok: true; config: PermissionsConfig; rules: Rule[] } | { ok: false; errors: RuleError[] } {
  if (raw === undefined) return { ok: false, errors: [{ index: -1, rule: 'permissions', reason: 'syntax' }] }
  const r = analyze(raw, ctx)
  return r.errors.length ? { ok: false, errors: r.errors } : { ok: true, config: r.config, rules: r.rules }
}

export class InvalidPermissions extends Error {
  constructor(public errors: RuleError[]) {
    super('invalid rules')
    this.name = 'InvalidPermissions'
  }
}

export interface PermissionsStoreDeps {
  config: { get(): KernelConfig; update(section: keyof KernelConfig, value: unknown): void }
  ctx: ParseCtx
}

/** 内存里的权限配置;set 先落盘,成功后才替换,之后的判定(含进行中的会话)都用新规则 */
export class PermissionsStore {
  private current: ParsedPermissions

  constructor(private deps: PermissionsStoreDeps) {
    this.current = parsePermissions(deps.config.get().permissions, deps.ctx)
  }

  get(): ParsedPermissions {
    return this.current
  }

  validate(raw: unknown): ReturnType<typeof validatePermissions> {
    return validatePermissions(raw, this.deps.ctx)
  }

  /** 无效 → InvalidPermissions,什么都不写 */
  set(raw: unknown): void {
    const v = this.validate(raw)
    if (!v.ok) throw new InvalidPermissions(v.errors)
    this.apply(v)
  }

  /** 写入已经 validate 过的结果(不再重跑用例):先落盘,成功后才换内存 */
  apply(v: { config: PermissionsConfig; rules: Rule[] }): void {
    this.deps.config.update('permissions', v.config)
    this.current = { config: v.config, rules: v.rules, errors: [] }
  }
}
