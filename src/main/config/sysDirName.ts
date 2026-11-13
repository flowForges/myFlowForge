// app 数据目录名(08 §18、评审修订 R12)。构建期(electron.vite.config.ts)和运行时(paths.ts)共用这一份规则,
// 没有别的依赖:配置文件在 Node 里直接 import 它。
export const DEFAULT_SYS_DIR_NAME = '.myFlowForge'

/** 一个点开头的目录名,只有 ASCII 字母数字和 ._-,不全是点;大小写折叠后不能是 .myFlowForge(不分大小写的盘上就是正式包的目录) */
export function isValidSysDirName(v: unknown): v is string {
  return typeof v === 'string' && /^\.[A-Za-z0-9._-]+$/.test(v) && !/^\.+$/.test(v)
    && v.toLowerCase() !== DEFAULT_SYS_DIR_NAME.toLowerCase()
}

/** 构建期:没设或空 → undefined(用默认);设了但不合格 → 抛错,npm run build 失败 */
export function buildSysDirName(v: string | undefined): string | undefined {
  if (v === undefined || v === '') return undefined
  if (!isValidSysDirName(v)) {
    throw new Error(`MFF_SYS_DIR_NAME=${JSON.stringify(v)} is invalid: use a dot name of ASCII letters, digits and ._- (e.g. .myFlowForge-test), not .myFlowForge in any case; unset it for the default`)
  }
  return v
}

/**
 * 构建期:MFF_TEST_BUILD。没设或空 → false(正式包);'1' → true,而且必须同时给一个合格的 MFF_SYS_DIR_NAME ——
 * 一个不自更新、却和正式包共用 ~/.myFlowForge 的「测试包」比没有测试包更糟;其它值一律让构建失败
 */
export function buildTestFlag(flag: string | undefined, sysDir: string | undefined): boolean {
  if (flag === undefined || flag === '') return false
  if (flag !== '1') throw new Error(`MFF_TEST_BUILD=${JSON.stringify(flag)} is invalid: use 1, or unset it for the release build`)
  if (buildSysDirName(sysDir) === undefined) throw new Error('MFF_TEST_BUILD=1 needs MFF_SYS_DIR_NAME (e.g. .myFlowForge-test) so the test build never shares ~/.myFlowForge')
  return true
}
