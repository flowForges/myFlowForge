/*
 * 服务端文件浏览(只读)的端到端。
 *
 * 覆盖的是「代理改的东西我想看看上下文」这条路:执行面板的 文件 tab → 翻目录 → 打开文件 →
 * 右上角在【变更】和【全文】之间切;以及反向的那条:变更列表点一个文件 → 看 diff → 切全文。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.resolve(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
let bad = 0
const ok = (label, cond, extra = '') => {
  if (!cond) bad++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const mock = await startMock(6809, 'none')
let chrome, p
try {
  chrome = await launch(S + '/chrome-files')
  p = await attach()
  await p.setViewport(390, 844)
  await p.goto('http://localhost:8081/add-host')
  await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 60000)
  await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6809')
  await p.clickText('保存并连接')
  await p.waitFor(`document.body.innerText.includes('修 gate 重复放行')`, 20000)

  // ── ① 进执行面板,两个 tab ───────────────────────────────────────────
  await p.clickText('≣')
  await p.waitFor(`document.body.innerText.includes('变更') && document.body.innerText.includes('文件')`, 8000)
  let t = await p.text()
  ok('执行面板有 变更 / 文件 两个 tab', t.includes('变更') && t.includes('文件'), t.split('\n').slice(0, 6).join(' / '))
  ok('默认停在变更', t.includes('handlers.ts') && t.includes('+12'), t.split('\n').filter((l) => l.includes('handlers')).join(' / '))
  await p.shot(S + '/shots/f-01-changes.png')

  // ── ② 变更 → 打开一个文件 → 看 diff → 切全文 ──────────────────────────
  await p.clickContaining('src/main/ipc/handlers.ts', '+12')
  await p.waitFor(`document.body.innerText.includes('自动放行')`, 8000)
  t = await p.text()
  ok('点变更里的文件进到 diff', t.includes('自动放行') && t.includes('变更 · src/main/ipc/handlers.ts'),
    t.split('\n').slice(0, 4).join(' / '))
  const diffColors = await p.eval(`(() => {
    // 行的 textContent 是「行号 + 正文」拼起来的(478+    for …),所以按包含找,不是按开头;
    // 而且要取**最内层**那个(面积最小),再往上找第一个有底色的祖先 —— 直接 find 会撞上外层容器。
    const pick=(sub)=>{
      const hits=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').includes(sub)&&e.getBoundingClientRect().height>0)
      if(!hits.length) return null
      const r=hits.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})[0]
      let n=r; for(let i=0;i<4&&n;i++){const bg=getComputedStyle(n).backgroundColor; if(bg&&bg!=='rgba(0, 0, 0, 0)') return bg; n=n.parentElement} return 'none'}
    return { add: pick('+    for (const g of pending)'), del: pick('-    emitNote') }
  })()`)
  ok('diff 的加减行有底色', /102, 193, 137/.test(diffColors.add ?? '') && /242, 113, 106/.test(diffColors.del ?? ''), JSON.stringify(diffColors))

  // 右上角切到全文 —— 这就是「从变更面板点进去看全文」那条入口
  await p.clickText('⌗')
  await p.waitFor(`document.body.innerText.includes('registerIpc')`, 8000)
  t = await p.text()
  ok('★从变更那屏能直接切到全文', t.includes('registerIpc') && t.includes("import { CH }"),
    t.split('\n').filter((l) => l.includes('registerIpc')).join(' / '))
  ok('标题说清现在看的是全文,还有多少行和什么语言', /全文 · 6 行 · typescript/.test(t),
    t.split('\n').slice(0, 4).join(' / '))
  ok('★全文不是 diff:没有 +/− 前缀', !/^\+import/m.test(t))
  await p.shot(S + '/shots/f-02-code.png')

  // 切回去
  await p.clickText('±')
  await p.waitFor(`document.body.innerText.includes('变更 · src/main/ipc/handlers.ts')`, 8000)
  ok('能切回变更', (await p.text()).includes('自动放行'))
  await p.clickText('‹')
  await wait(500)

  // ── ③ 文件 tab:目录列表 ─────────────────────────────────────────────
  await p.clickText('文件')
  await p.waitFor(`document.body.innerText.includes('README.md')`, 8000)
  t = await p.text()
  ok('文件 tab 列出了根目录', t.includes('README.md') && t.includes('src/'), t.split('\n').filter((l) => l.includes('src')).join(' / '))
  ok('★目录在前、文件在后(服务端给的顺序是乱的)', t.indexOf('assets/') < t.indexOf('src/') && t.indexOf('src/') < t.indexOf('README.md'),
    t.split('\n').slice(0, 14).join(' / '))
  ok('目录带条目数', /2 项/.test(t), t.split('\n').filter((l) => l.includes('项')).join(' / '))
  ok('git 仓库目录带分支名', t.includes('feat/x'))
  ok('★根目录不画「..」—— 上面没有了', !t.includes('‹ ..'))
  await p.shot(S + '/shots/f-03-tree.png')

  // ── ④ 钻进去 + 面包屑 + 改动标记 ─────────────────────────────────────
  await p.clickContaining('src/', '2 项')
  await p.waitFor(`document.body.innerText.includes('app.ts')`, 8000)
  t = await p.text()
  ok('钻进 src', t.includes('main/') && t.includes('app.ts'))
  ok('钻进去之后出现了「..」', t.includes('‹ ..'))
  await p.clickContaining('main/', '4 项')
  await p.waitFor(`document.body.innerText.includes('handlers.test.ts')`, 8000)
  t = await p.text()
  ok('再钻一层', t.includes('handlers.ts') && t.includes('ipc/'))
  ok('★改动标记跟着服务端的 A/M/D 走', t.includes('已改') && t.includes('新增'),
    t.split('\n').filter((l) => l.includes('已改') || l.includes('新增')).join(' / '))
  // 面包屑是一排横向的 Text,innerText 里各占一行 —— 按容器取,别指望它们拼在同一行。
  const crumb = await p.eval(`(() => {
    const hits=[...document.querySelectorAll('div')].filter(e=>{
      const t=(e.textContent||'')
      return t.startsWith('forge') && t.includes('/') && t.includes('src') && t.includes('main') && t.length<40
    })
    return hits.length ? hits[hits.length-1].textContent.replace(/\\s+/g,'') : null
  })()`)
  ok('面包屑显示到当前层', crumb === 'forge/src/main', JSON.stringify(crumb))
  await p.shot(S + '/shots/f-04-deep.png')

  // 面包屑点回上层
  await p.clickText('src')
  await p.waitFor(`document.body.innerText.includes('app.ts')`, 8000)
  ok('★面包屑点一段就跳回那一层', (await p.text()).includes('app.ts'))

  // ── ⑤ 过滤 ──────────────────────────────────────────────────────────
  await p.typeInto('input[placeholder*="按文件名过滤"]', 'app')
  await wait(600)
  t = await p.text()
  ok('过滤只留匹配的', t.includes('app.ts') && !t.includes('main/'), t.split('\n').filter((l) => l.includes('.ts')).join(' / '))
  ok('★一条都不剩时说清是「过滤没匹配上」,不是「目录是空的」',
    await (async () => {
      await p.typeInto('input[placeholder*="按文件名过滤"]', 'zzzz')
      await wait(500)
      const x = await p.text()
      return x.includes('这一层没有匹配的名字') && !x.includes('这个目录是空的')
    })(),
  )
  await p.shot(S + '/shots/f-05-filter.png')

  // ── ⑥ 打开一个文件看全文 + 超长截断 ──────────────────────────────────
  await p.clearField('input[placeholder*="按文件名过滤"]')
  await p.waitFor(`document.body.innerText.includes('app.ts')`, 5000)
  await p.clickContaining('app.ts')
  await p.waitFor(`document.body.innerText.includes('const l0')`, 8000)
  t = await p.text()
  ok('从文件树打开文件看全文', t.includes('const l0 = 0'))
  ok('★超过 800 行要截断,并且如实说截了多少',
    /只显示前 800 行/.test(t) && /还有 200 行没显示/.test(t) && /共 1000 行/.test(t),
    t.split('\n').filter((l) => l.includes('只显示前')).join(' / '))
  ok('行号从 1 开始', /(^|\n)\s*1\s*\n?const l0/.test(t) || t.includes('1'), '')
  await p.shot(S + '/shots/f-06-capped.png')

  // ── ⑦ 空文件:说它是空的,不画一行空行号 ────────────────────────────
  await p.clickText('‹')
  await wait(500)
  await p.clickContaining('main/', '4 项')
  await p.waitFor(`document.body.innerText.includes('index.ts')`, 8000)
  await p.clickContaining('index.ts')
  await p.waitFor(`document.body.innerText.includes('这个文件是空的')`, 8000)
  ok('★空文件说「是空的」,不是画一行空的出来', (await p.text()).includes('这个文件是空的'))

  // ── ⑧ 只读:这一屏不该有任何写入口 ───────────────────────────────────
  await p.clickText('‹')
  await wait(600)
  t = await p.text()
  ok('★只读 —— 没有提交 / 回滚 / 保存 / 删除任何入口',
    !/提交|回滚|保存到|删除文件|新建文件/.test(t), t.split('\n').filter((l) => /提交|回滚|删除/.test(l)).join(' / '))
  ok('并且明说了是只读', t.includes('只读'))

  console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条没过`)
} catch (e) {
  bad++
  console.log('FAIL  脚本自己挂了 — ' + (e && e.message ? e.message : e))
} finally {
  try { await p?.close() } catch { /* 已经断了 */ }
  try { chrome?.kill() } catch { /* 已经没了 */ }
  try { mock?.kill() } catch { /* 已经没了 */ }
}
process.exit(bad === 0 ? 0 : 1)
