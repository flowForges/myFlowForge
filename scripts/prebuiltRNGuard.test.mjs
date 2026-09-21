import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

// 插件在 mobile/plugins 里(expo prebuild 从那儿加载),测试放在 scripts 这个 vitest project 下跑。
const require = createRequire(import.meta.url)
const { injectGuard, MARKER } = require('../mobile/plugins/withPrebuiltRNGuard.js')

const PODFILE = `target 'myFlowForge' do
  use_expo_modules!
  post_install do |installer|
    react_native_post_install(installer)
  end
end
`

describe('withPrebuiltRNGuard · injectGuard', () => {
  it('闸插在 post_install 的最前面(在 react_native_post_install 之前)', () => {
    const out = injectGuard(PODFILE)
    const at = out.indexOf(MARKER)
    expect(at).toBeGreaterThan(out.indexOf('post_install do |installer|'))
    expect(at).toBeLessThan(out.indexOf('react_native_post_install'))
    expect(out).toContain("__ff_pods.include?('React-Core-prebuilt')")
    expect(out).toContain("__ff_pods.include?('ReactNativeDependencies')")
    expect(out).toContain('raise Pod::Informative')
  })

  it('跑两次只插一次(prebuild 会反复跑)', () => {
    const once = injectGuard(PODFILE)
    expect(injectGuard(once)).toBe(once)
    expect(once.split(MARKER).length - 1).toBe(1)
  })

  /** ★找不到挂点时静默跳过 = 这道闸不存在,而表面上一切正常。必须让 prebuild 失败。 */
  it('★Podfile 里没有 post_install 就报错,不静默跳过', () => {
    expect(() => injectGuard("target 'x' do\nend\n")).toThrow(/找不到 `post_install/)
  })
})
