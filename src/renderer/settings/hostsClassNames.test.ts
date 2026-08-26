import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const rendererRoot = join(here, '..')

/**
 * ★这一屏第一版的三个 UI 毛病(标签字号比邻居大一号、开关退化成系统原生复选框、
 *  地址那行乱换行)是**同一个**根因:`set-label` / `set-switch` / `grow` 这些 class
 *  在整个项目的 CSS 里根本不存在。写了等于没写,浏览器不会报错,只会安静地退回默认样式 ——
 *  于是 typecheck 全绿、测试全绿,用户一眼就看出不对。
 *
 * 所以这里不测「长什么样」(那要真 Chrome 量 computed style,jsdom 验不了),
 * 只钉死一条:**这两个文件里出现的每个 class 名,CSS 里必须真有一条规则**。
 */
function allCss(): string {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.css')) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(rendererRoot)
  // ★注释要先剥掉。否则 hostspane.css 里那句「不要自造 .set-label」自己就把守卫喂饱了 ——
  //  守卫写完第一次跑就是被这行注释骗成绿的。
  return out.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/** 只取字面量 className("a b c" 和 `a b ${x}` 的字面部分),模板里的表达式跳过。 */
function classNamesIn(src: string): string[] {
  const found = new Set<string>()
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/\$\{[^}]*\}/g, ' ')
    for (const c of raw.split(/\s+/)) if (c && /^[a-zA-Z][\w-]*$/.test(c)) found.add(c)
  }
  return [...found]
}

describe('主机设置里的 class 名都得真有对应的 CSS', () => {
  const css = allCss()
  const has = (c: string) => new RegExp(`\\.${c}(?![\\w-])`).test(css)

  for (const file of ['HostsPane.tsx', 'MobileSection.tsx']) {
    it(file, () => {
      const used = classNamesIn(readFileSync(join(here, file), 'utf8'))
      expect(used.length).toBeGreaterThan(8) // 抓到东西了才算数
      expect(used.filter((c) => !has(c))).toEqual([])
    })
  }

  // 这三个是当初真的被写进去过的幽灵 class。守卫本身必须能对它们变红。
  it('幽灵 class 会被抓住', () => {
    expect(has('set-label')).toBe(false)
    expect(has('set-switch')).toBe(false)
    expect(has('toggle')).toBe(true)
    expect(has('proj-field')).toBe(true)
  })
})
