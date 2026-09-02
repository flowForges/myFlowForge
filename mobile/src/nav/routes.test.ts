import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ROUTES } from './routes'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '../../app')
const SRC = resolve(HERE, '../../src')

/** 递归收集 .ts / .tsx(跳过测试文件和这张表自己)。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = resolve(dir, n)
    if (statSync(p).isDirectory()) { sources(p, out); continue }
    if (!/\.tsx?$/.test(n) || n.includes('.test.')) continue
    if (p === resolve(HERE, 'routes.ts')) continue
    out.push(p)
  }
  return out
}

describe('路由字符串', () => {
  it('每一条都是绝对路径', () => {
    for (const [k, v] of Object.entries(ROUTES)) expect(v, k).toMatch(/^\//)
  })

  it('★★分组名绝不许漏进路由字符串里', () => {
    // expo-router 的 `(tabs)` 是**分组**,不进 URL —— `/index` 才是对的,`/(tabs)/index` 不是。
    // 写错了不会报错:router.replace('/(tabs)/index') 只是静默什么也不做,
    // 而 goBack() 的兜底正是靠它 —— 症状是「没有返回栈时点返回,屏幕一动不动」。
    for (const [k, v] of Object.entries(ROUTES)) expect(v, k).not.toContain('(')
  })

  it('首页是根', () => {
    expect(ROUTES.home).toBe('/')
  })

  it('三个 tab 都在,且互不相同', () => {
    const tabs = [ROUTES.home, ROUTES.hosts, ROUTES.settings]
    expect(new Set(tabs).size).toBe(3)
  })

  /**
   * ★★每一条路由都得**真有一个屏文件**。
   *  这是这个文件里唯一能抓住「打错字」的一条:`router.push('/notification')`(少个 s)
   *  在 expo-router 下**不报错、不跳转、不打日志** —— 屏幕一动不动,和「按钮没接线」
   *  一模一样。上面那几条只看字符串长得对不对,拼错的字符串照样全绿。
   */
  it('★每条路由都有对应的屏文件 —— 打错字的路由是静默失效的', () => {
    for (const [k, v] of Object.entries(ROUTES)) {
      const name = v.replace(/^\//, '') || 'index'
      // 底部 tab 那三格在 `app/(tabs)/` 里(圆括号是分组,不进 URL);其余都在 `app/` 根下。
      const found = existsSync(`${APP}/${name}.tsx`) || existsSync(`${APP}/(tabs)/${name}.tsx`)
      expect(found, `ROUTES.${k} = ${v} 找不到对应的屏文件`).toBe(true)
    }
  })

  it('没有重复的目标 —— 两个名字指同一个屏,迟早有人只改其中一个', () => {
    const vals = Object.values(ROUTES)
    expect(new Set(vals).size).toBe(vals.length)
  })
})

describe('★★这张表是唯一来源 —— 扫全仓', () => {
  it('没有任何一处再直接写字面量路径', () => {
    // 2026-09-02 之前:十几处 `router.push('/hosts')` 和这张表并存,`(tabs)/index.tsx` 里
    // 同一颗按钮甚至两种写法都有。写错一个字面量**不会报错** —— expo-router 只是静默不动,
    // 表现是「点了没反应」。所以迁完之后必须有一条扫全仓的断言钉住,不然它会慢慢长回来。
    const bad: string[] = []
    for (const f of [...sources(APP), ...sources(SRC)]) {
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/router\.(?:push|replace|navigate)\(\s*['"`]\//g)) {
        const line = text.slice(0, m.index).split('\n').length
        bad.push(`${f.split('/mobile/')[1]}:${line}`)
      }
    }
    expect(bad, `这几处该改成 ROUTES.*:\n${bad.join('\n')}`).toEqual([])
  })
})
