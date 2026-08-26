import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ★同 localData.test.ts:AsyncStorage 一 import 就把 react-native 拖进来,node 项目下必须 mock。
//  这里 mock 只是为了能把 LOCAL_PREFIX **从定义它的那个模块**读出来 —— 在测试里手抄一个 'mff.'
//  等于给守卫留一份影子副本:改了那边、这边照样绿。
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
import { LOCAL_PREFIX } from './localData'

/**
 * ★★`clearLocalData()` 是**按前缀扫**的 —— 「清除本地数据」清得干不干净,完全取决于
 *  「这个 app 存的每一个 key 都以 `mff.` 开头」这条**约定**。而约定没有任何东西在兑现:
 *  哪天谁写下 `const KEY = 'forge.foo'`,那份令牌/偏好就会**安安静静地活过**一次
 *  声称「已清除」的清除。本仓库已经栽过同一个形状:按命名约定枚举的守卫,
 *  被一个不守约定的名字静默架空。
 *
 * 所以这条守卫**不读名单,读源码**:把手机端源码里真正交给 AsyncStorage 的 key 全捞出来,
 * 逐个验前缀。手抄一份 key 名单(哪怕抄得很全)得的是同一种病 —— 新 key 不进名单就不被看见。
 *
 * ★同样刻意**不按路径枚举文件**(那种守卫会被一次改名静默架空),而是整棵树走一遍。
 * ★捞不出来的 key 一律**判红**,不是跳过:静默跳过等于给「看不懂就当没有」开了口子,
 *  而那正是这条守卫要防的东西。
 */

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/**
 * 单 key 的那几个方法。`getAllKeys` / `multiRemove` 不在内:它们收的是**扫出来**的 key
 * (见 localData.ts)。
 *
 * ★每次现造一个,别共用一个 `/g` 常量:带 `g` 的正则有 `lastIndex` 状态,
 *  `.test()` 和 `.matchAll()` 混着用会让**第二次调用从上一次停的地方开始**,
 *  于是同一个文件时而匹配得到时而匹配不到 —— 这条守卫会变成一条掷硬币的断言。
 */
const singleKeyCall = () => /AsyncStorage\.(?:getItem|setItem|removeItem|mergeItem)\s*\(\s*([^,)]+)/g

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

/** 一个文件里所有交给 AsyncStorage 的 key。`{ key }` 是认出来的,`{ expr }` 是没认出来的(要判红)。 */
function keysIn(src: string): { key?: string; expr: string }[] {
  const found: { key?: string; expr: string }[] = []
  for (const m of src.matchAll(singleKeyCall())) {
    const expr = m[1].trim()
    // 直接写的字面量。带 `${}` 的模板串认不出来 —— 那种就落到下面判红。
    const lit = /^'([^'${}]*)'$|^"([^"${}]*)"$|^`([^`${}]*)`$/.exec(expr)
    if (lit) { found.push({ key: lit[1] ?? lit[2] ?? lit[3], expr }); continue }
    // 同文件里的 `const X = '…'`。手机端这四个 key 全是这么写的。
    if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
      const decl = new RegExp(`\\bconst\\s+${expr}\\s*=\\s*(['"\`])([^'"\`$]*)\\1`).exec(src)
      if (decl) { found.push({ key: decl[2], expr }); continue }
    }
    found.push({ expr })
  }
  return found
}

const FILES = [path.join(MOBILE, 'src'), path.join(MOBILE, 'app')]
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d))
  .map((f) => ({ file: path.relative(MOBILE, f), src: fs.readFileSync(f, 'utf8') }))
  .filter((f) => f.src.includes('@react-native-async-storage/async-storage'))

describe('本地存储的 key', () => {
  it('★扫得到东西 —— 一条什么都没扫到的守卫是永远绿的守卫', () => {
    // 这条不是在数「应该有几个 key」(那就成了另一份手抄名单),它只钉「扫描本身还活着」:
    // 哪天 import 路径变了、正则被改坏了,下面那条会因为集合为空而假绿,这条会先红。
    expect(FILES.length).toBeGreaterThan(0)
    const all = FILES.flatMap((f) => keysIn(f.src))
    expect(all.length).toBeGreaterThan(0)
  })

  it('★★每一个交给 AsyncStorage 的 key 都以 mff. 开头 —— 否则「清除本地数据」会漏掉它', () => {
    const bad: string[] = []
    for (const f of FILES) {
      for (const k of keysIn(f.src)) {
        if (k.key === undefined) {
          // 认不出来的照样判红:静默跳过等于给「看不懂就当没有」开口子。
          bad.push(`${f.file}: 看不懂这个 key —— \`${k.expr}\`。请写成同文件里的 const 字面量。`)
        } else if (!k.key.startsWith(LOCAL_PREFIX)) {
          bad.push(`${f.file}: \`${k.key}\` 不以 ${LOCAL_PREFIX} 开头 —— clearLocalData() 按前缀扫,它会活过一次「已清除」。`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('每个用到单 key 方法的文件都真的被解析出了 key(解析失效会让上面那条假绿)', () => {
    const blind = FILES.filter((f) => singleKeyCall().test(f.src) && keysIn(f.src).length === 0).map((f) => f.file)
    expect(blind).toEqual([])
  })
})
