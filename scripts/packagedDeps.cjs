// 打好的包里，`out/` 真正 require 的每一个外部包，都必须**真的躺在包内的 node_modules 里**。
//
// ★★为什么需要这道闸：electron-builder 只打 `dependencies`，不打 `devDependencies`。于是
//  「把一个包从 dependencies 挪走」和「新加一个运行时依赖却写进了 devDependencies」，这两件事
//  的后果一模一样 —— **构建全绿、产物齐全、本机 `npm run dev` 一切正常**，因为开发时两种依赖
//  都在 node_modules 里；只有用户装上那个包、点到那条代码路径时，才会炸一句 Cannot find module。
//
// 本机没有 CI，包是手工打的，这类错误没有任何其它地方能拦。所以放在 afterPack 里，每次打包都查。
//
// ★ 只看**静态字面量** `require("x")`。动态 `import(变量)` 查不到，也**不该**查 —— 那正是
//   feishuTransport 那种「装了就用、没装就给个提示」的可选依赖的写法（见 src/main/bot/feishuTransport.ts）。

const { readdirSync, existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { builtinModules } = require('node:module')

// electron 由 Electron 运行时自己提供，不在 app/node_modules 里。
const PROVIDED = new Set([...builtinModules, 'electron'])

/** 把 `require("lodash/fp")` 这种还原成包名 `lodash`；作用域包保留两段。 */
function toPackageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/')
  return spec.split('/')[0]
}

/** 递归收集 dir 下所有 .js 里静态 require 的**外部**包名。 */
function externalRequires(dir) {
  const found = new Set()
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.isFile() || !e.name.endsWith('.js')) continue
      // ★ 产物里有中文，按 utf8 读；用 grep 那类工具会把它当二进制跳过（这个坑踩过）。
      let src
      try { src = readFileSync(p, 'utf8') } catch { continue }
      for (const m of src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1]
        if (spec.startsWith('.') || spec.startsWith('/')) continue   // 相对/绝对路径，不是包
        if (spec.startsWith('node:')) continue
        const name = toPackageName(spec)
        if (PROVIDED.has(name)) continue
        found.add(name)
      }
    }
  }
  walk(dir)
  return found
}

/**
 * 验收：`<appDir>/out` 里 require 的每个包，都要能在 `<appDir>/node_modules` 里找到。
 * 少一个就**让构建挂掉** —— 别把一个「装上才发现打不开」的包发出去。
 */
function verifyPackagedDeps(appDir, log = console.log) {
  const outDir = join(appDir, 'out')
  if (!existsSync(outDir)) {
    throw new Error(`[deps] 包里没有 out/：${outDir}`)
  }
  const needed = [...externalRequires(outDir)].sort()
  const missing = needed.filter((n) => !existsSync(join(appDir, 'node_modules', n)))
  if (missing.length) {
    throw new Error(
      `[deps] 包里少了 ${missing.length} 个运行时依赖，用户装上会炸 Cannot find module：\n  ` +
      missing.join('\n  ') +
      '\n  这些包要放在 package.json 的 **dependencies** 里（devDependencies 不会被打进包）。',
    )
  }
  log(`[deps] ✓ ${needed.length} 个运行时依赖都在包里：${needed.join(', ')}`)
}

module.exports = { externalRequires, verifyPackagedDeps, toPackageName }
