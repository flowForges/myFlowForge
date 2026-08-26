import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string) => readFileSync(join(MOBILE, p), 'utf8')

/** 静态 import(会被 metro 提到最前面无条件执行),不算注释里和 require() 里的。 */
const staticImports = (src: string): string[] =>
  [...src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .matchAll(/^\s*import\s[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('相机只能在确认装得上之后才碰', () => {
  /**
   * ★★真机上崩过:手机上装的包是加相机之前打的,而 JS 是新的。
   *  `expo-camera` 在 **import 那一行**就 `requireNativeModule('ExpoCamera')`,当场抛 ——
   *  按钮照常显示、点下去整个 app 崩在 `scan.tsx:4`。
   *
   *  修法是把相机那一屏挪进 `src/scan/Scanner.tsx`,路由先问 `scanSupport()` 再 `require`。
   *  这条断言钉住的就是「别再静态 import 回去」—— 那是个一行改动就能复发、
   *  而且**只有在旧包的真机上**才看得见的回归。
   */
  for (const f of ['app/scan.tsx', 'app/add-host.tsx', 'app/hosts.tsx', 'app/index.tsx', 'app/_layout.tsx']) {
    it(`${f} 不静态 import expo-camera`, () => {
      expect(staticImports(read(f))).not.toContain('expo-camera')
    })
  }

  it('相机那一屏确实被隔离在路由之外(而且路由是 require 进去的)', () => {
    // Scanner 自己可以放心 import —— 它只会在 support === 'ok' 时被 require 进来。
    expect(staticImports(read('src/scan/Scanner.tsx'))).toContain('expo-camera')
    const route = read('app/scan.tsx')
    expect(route).toMatch(/require\(\s*['"]\.\.\/src\/scan\/Scanner['"]\s*\)/)
    // ★ require 必须**挂在** support 判断上,不能无条件跑
    expect(route).toMatch(/support === 'ok'\s*\?[\s\S]{0,120}require\(/)
  })

  it('探测用的是 requireOptionalNativeModule —— requireNativeModule 会抛,那就白探了', () => {
    // ★注释要先剥掉:scanSupport.ts 的文档注释里就写着 `requireNativeModule('ExpoCamera')`
    //  (在解释崩的原因),不剥的话这条断言被那句注释喂成红的 —— 上一个守卫是被喂成绿的,方向相反、
    //  病因一样:拿正则扫源码就必须先把注释扔掉。
    const probe = read('src/net/scanSupport.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
    expect(probe).toContain('requireOptionalNativeModule')
    expect(probe).not.toMatch(/(^|[^a-zA-Z])requireNativeModule\(/)
  })
})
