import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = __dirname

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/**
 * 只有「桌面外壳」允许 import electron。**这张名单就是外壳的定义。**
 *
 * 名单变长 = 有人把 Electron 依赖带进了核心。第二期的 Linux daemon 直接 import 这些代码,
 * 而那台机器上根本没有 electron 这个包 —— 会在 require 阶段就炸,且在 mac 上跑测试
 * 永远发现不了。没有任何功能测试能替这条不变式站岗,所以有了这个文件。
 *
 * 真要往里加,先回答:这个文件是不是外壳?不是的话,把 Electron 的那部分抽进
 * `src/main/host/capabilities.ts` 的宿主能力接口,而不是往这张名单里加一行。
 */
const SHELL_ALLOWLIST = [
  'appearance/backgroundProtocol.ts',
  'appearance/fontProtocol.ts',
  'host/electronHost.ts',
  'index.ts',
  'notify/osNotify.ts',
  'pet/petProtocol.ts',
  'shortcuts/globalShortcuts.ts',
  'windows/mainWindow.ts',
  'windows/petWindow.ts',
  'windows/windowRegistry.ts',
].sort()

describe('核心边界', () => {
  it('只有桌面外壳 import electron', () => {
    const offenders = walk(ROOT)
      .filter((p) => /from ['"]electron['"]/.test(readFileSync(p, 'utf8')))
      // 路径分隔符归一:这个测试也要能在 Windows 上跑。第一期就踩过「测试写死 POSIX 路径」
      // 这个坑(三个文件因此在 Windows 上挂掉)。
      .map((p) => relative(ROOT, p).split(sep).join('/'))
      .sort()
    expect(offenders).toEqual(SHELL_ALLOWLIST)
  })

  it('handlers.ts 不在名单里 —— 它是核心,不是外壳', () => {
    // 单独钉死这一条:它是这次剥离的全部意义所在,而上面那条断言在名单被人整体改写时
    // 会跟着一起变绿。
    expect(SHELL_ALLOWLIST).not.toContain('ipc/handlers.ts')
  })
})
