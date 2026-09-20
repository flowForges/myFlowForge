// catalog.ts 里的 Windows 路径模板,从【真文件】里读出来。
//
// 为什么用正则读源码而不是在诊断脚本里抄一份:抄的那份会悄悄漂移 —— 改了 catalog 却忘了改脚本,
// 体检报告就会漏报"某个软件探不到",而那正是它唯一的用途。
//
// 单引号字面量和反引号模板串都要认。jetbrains()/vscodeLike() 两个辅助函数用的是后者,
// 只认单引号会漏掉 JetBrains 全家和 VS Code 系的主路径 —— 那是模板总数的四分之三。
export function openerTemplates(src) {
  const raw = [...src.matchAll(/['`](%[^%'`]+%\\\\[^'`]*)['`]/g)].map(m => m[1].replace(/\\\\/g, '\\'))
  const jbExes = [...src.matchAll(/jetbrains\('([^']+)'\)/g)].map(m => m[1])
  const vscodeDirs = [...src.matchAll(/vscodeLike\('([^']+)', '([^']+)'/g)]
  const out = []
  for (const t of raw) {
    const hasExe = t.includes('${exe}')
    const hasDir = t.includes('${dir}')
    // vscodeLike 的模板同时带 dir 和 exe;jetbrains 的只带 exe。靠这个区分该用哪份参数展开。
    if (hasDir && hasExe) { for (const [, d, e] of vscodeDirs) out.push(t.replace(/\$\{dir\}/g, d).replace(/\$\{exe\}/g, e)) }
    else if (hasExe) { for (const e of jbExes) out.push(t.replace(/\$\{exe\}/g, e)) }
    else if (!t.includes('${')) out.push(t)
  }
  return [...new Set(out)]
}
