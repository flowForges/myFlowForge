import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// @ts-expect-error — plain .mjs helper shared with scripts/win-doctor.mjs (no types)
import { openerTemplates } from '../../../scripts/openerTemplates.mjs'

// scripts/win-doctor.mjs 靠正则从 catalog.ts 里抠出路径模板,在真机上逐条探测「这个软件装了没」。
// 那个正则漏一条,体检报告就少验一个软件 —— 而它整个存在的意义就是替我们验这些。第一版只认单引号,
// 漏掉了 jetbrains()/vscodeLike() 用反引号写的那些,67 条里只抠出 10 条,JetBrains 全家和 VS Code
// 系的主路径一个没验。这组测试就是拴住那个正则的。
const CATALOG = readFileSync(join(__dirname, 'catalog.ts'), 'utf8')
const PS1 = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'win-doctor.ps1'), 'utf8')

describe('win-doctor 的路径模板提取', () => {
  const templates: string[] = openerTemplates(CATALOG)

  it('抠出的条数和 catalog 里的规模对得上(不是只抠到零头)', () => {
    // catalog 里字面量 + 两个模板函数展开后是几十条量级;掉到 20 以下必然是正则又漏了一类写法。
    expect(templates.length).toBeGreaterThan(20)
  })

  it('★ 展开了 jetbrains() —— 第一版就是漏了这一整类', () => {
    expect(templates.some(t => t.includes('idea64.exe'))).toBe(true)
    expect(templates.some(t => t.includes('pycharm64.exe'))).toBe(true)
  })

  it('★ 展开了 vscodeLike() —— VS Code / Cursor 的主安装路径', () => {
    expect(templates.some(t => t.includes('Microsoft VS Code\\Code.exe'))).toBe(true)
    expect(templates.some(t => t.includes('Cursor.exe'))).toBe(true)
  })

  it('没有漏网的未展开占位符(展开失败会变成去探一个字面写着 ${exe} 的路径)', () => {
    for (const t of templates) expect(t, t).not.toContain('${')
  })

  it('每条都是 %VAR% 开头的绝对路径(和 catalog 自己的不变式一致)', () => {
    for (const t of templates) expect(t, t).toMatch(/^%[^%]+%\\/)
  })

  it('catalog 里每一个 .exe 名字都至少出现在一条展开后的模板里', () => {
    // 只认【引号或反斜杠开头、引号结尾】的,否则会把注释里的散文当成 exe 名(第一版就误伤了「an app is an .exe」)。
    const exes = [...CATALOG.matchAll(/[\\'`]([A-Za-z0-9][A-Za-z0-9_ -]*\.exe)['`]/g)].map(m => m[1])
    for (const exe of new Set(exes)) {
      expect(templates.some(t => t.endsWith(exe)), `没有一条模板指向 ${exe}`).toBe(true)
    }
  })

  // win-doctor.ps1 是零安装版(只用 Windows 自带的 PowerShell,不需要 Node)。它没法读 catalog.ts —— 用户
  // 拿到的就是这一个文件,仓库都还没克隆 —— 所以模板是【生成进去】的。生成命令:
  //   node --input-type=module -e "import{readFileSync,writeFileSync}from'node:fs';..." (见 git 历史)
  // 这组断言就是那份拷贝的看门狗:改了 catalog 却没重新生成 ps1,体检报告会漏验软件而不报错。
  it('★ win-doctor.ps1 里生成的模板和 catalog 一致(改了 catalog 要重新生成 ps1)', () => {
    for (const t of templates) {
      // PowerShell 单引号字符串里,单引号自身要写成两个
      expect(PS1, `ps1 里缺这条模板:${t}`).toContain(t.replace(/'/g, "''"))
    }
  })

  it('win-doctor.ps1 是 UTF-8 BOM 开头 —— 没有 BOM 的话 PS 5.1 会把中文读成乱码', () => {
    const bytes = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'win-doctor.ps1'))
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
  })
})
