/*
 * 工具卡 + 轮次分隔线的端到端。
 *
 * 为什么值得单独一个脚本:这一块的价值**全在看得见**。纯函数单测能钉住「解析对不对」,
 * 但钉不住「它到底画出来了没有、颜色对不对、展开之后是不是真有 diff」。
 * 所以这里一律**量真 DOM 和 computed style**,不只看文本。
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

// ★等它真的开始监听再往下走,别 sleep 完就当它起来了(见 harness.mjs 里那段血泪)。
const mock = await startMock(6808, 'none')

let chrome, p
try {
  chrome = await launch(S + '/chrome-tools')
  p = await attach()
  await p.setViewport(390, 844)
  await p.goto('http://localhost:8081/add-host')
  await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 60000)
  await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6808')
  await p.clickText('保存并连接')
  await p.waitFor(`document.body.innerText.includes('477–481')`, 20000)

  let t = await p.text()
  ok('落在有工具卡的那个会话', t.includes('修 gate 重复放行'), t.split('\n')[0])

  // ── ① 折叠态:动词 / 目标 / 统计 ────────────────────────────────────────────
  ok('读取卡:动词 + 路径 + 行号区间', t.includes('读取') && t.includes('src/main/ipc/handlers.ts') && t.includes('477–481'),
    t.split('\n').filter((l) => l.includes('477')).join(' / '))
  ok('编辑卡:+3 −1(从真 diff 数出来的,不是编的)', /\+3/.test(t) && /−1/.test(t),
    t.split('\n').filter((l) => l.includes('编辑')).join(' / '))
  ok('★执行卡剥掉了 codex 的登录 shell 壳', t.includes('npm test -- ipc') && !t.includes('/bin/zsh -lc'),
    t.split('\n').filter((l) => l.includes('npm test')).join(' / '))
  ok('★没有 output 的那张卡照样画出来了(codex 的编辑文件)', t.includes('handlers.test.ts'))
  ok('失败的那张打叉', t.includes('✗'), t.split('\n').filter((l) => l.includes('typecheck')).join(' / '))
  ok('成功的打勾', t.includes('✓'))
  ok('★折叠时输出不露出来', !t.includes('const drainGates'), '读取卡的正文不该在折叠态出现')

  // 卡片的缩进必须跟着代理气泡走(paddingLeft 26 的那一栏),不是独立消息
  // 卡片左边缘要比正文气泡更靠右一点吗?不 —— 原型里 `.tool` 和 `.m-ai .bd` 的左缘**对齐**
  // (都是 26px 那一栏)。所以量的是「卡片左缘 == 正文左缘」。
  const geom = await p.eval(`(() => {
    const all=[...document.querySelectorAll('*')]
    const head=all.filter(e=>{const t=e.textContent||''; return t.includes('477–481') && t.includes('读取')})
      .sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})[0]
    if(!head) return null
    // 从表头往上找那张卡(有圆角边框的那层)
    let card=head; for(let i=0;i<5&&card;i++){ if(getComputedStyle(card).borderTopLeftRadius!=='0px') break; card=card.parentElement }
    const body=all.filter(e=>(e.textContent||'').startsWith('先看现在的放行逻辑'))
      .sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})[0]
    return { card: card && card.getBoundingClientRect().left, body: body && body.getBoundingClientRect().left }
  })()`)
  ok('★工具卡和正文左缘对齐(挂在这条回复下面,不是独立消息)',
    geom && Math.abs(geom.card - geom.body) <= 1 && geom.card >= 26, JSON.stringify(geom))

  await p.shot(S + '/shots/t-01-collapsed.png')

  // ── ② 展开编辑卡:行级 diff,颜色量出来 ────────────────────────────────────
  // ★按「路径 + 统计」定位那一张,别只按动词 —— 页面上有两张「编辑」卡。
  await p.clickContaining('编辑', 'src/main/ipc/handlers.ts', '+3')
  await wait(600)
  t = await p.text()
  ok('展开后看得到 diff 正文', t.includes('for (const g of pending)') && t.includes('emitNote'),
    t.split('\n').filter((l) => l.includes('pending')).join(' / '))

  const colors = await p.eval(`(() => {
    const rows=[...document.querySelectorAll('div')].filter(e=>{
      const tx=e.textContent||''
      return e.children.length<=2 && (tx.startsWith('+    for (const g of pending)') || tx.startsWith('-    emitNote'))
    })
    const pick=(pfx)=>{
      const r=rows.find(e=>(e.textContent||'').startsWith(pfx))
      if(!r) return null
      let n=r
      for(let i=0;i<4 && n;i++){
        const bg=getComputedStyle(n).backgroundColor
        if(bg && bg!=='rgba(0, 0, 0, 0)' && bg!=='transparent') return bg
        n=n.parentElement
      }
      return 'none'
    }
    return { add: pick('+    for'), del: pick('-    emitNote') }
  })()`)
  // 深色下 addBg = rgba(102,193,137,.14),delBg = rgba(242,113,106,.14)
  ok('★新增行是绿底(量的是 computed style,不是我觉得)', /102, 193, 137/.test(colors.add ?? ''), JSON.stringify(colors.add))
  ok('★删除行是红底', /242, 113, 106/.test(colors.del ?? ''), JSON.stringify(colors.del))
  ok('★上下文行不上色', colors.add !== colors.del)
  await p.shot(S + '/shots/t-02-diff.png')
  await p.clickContaining('编辑', 'src/main/ipc/handlers.ts', '+3')
  await wait(400)

  // ── ③ 展开读取卡:行号列 ───────────────────────────────────────────────────
  await p.clickContaining('读取', '477–481')
  await wait(600)
  t = await p.text()
  ok('读取卡展开后有行号', t.includes('477') && t.includes('const drainGates'),
    t.split('\n').filter((l) => l.includes('drainGates')).join(' / '))
  // ★这一条要量几何,不能只看文本:innerText 里本来就没有 tab,`!includes('477\\tconst')` 是永远绿的假断言。
  const lnCol = await p.eval(`(() => {
    const cells=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').trim()==='477' && e.children.length===0)
    if(!cells.length) return null
    const e=cells[cells.length-1]
    const cs=getComputedStyle(e)
    const r=e.getBoundingClientRect()
    const row=e.parentElement
    const sib=row && [...row.children].find(k=>k!==e)
    return { w: Math.round(r.width), align: cs.textAlign, sibStartsWith: sib ? (sib.textContent||'').slice(0,5) : null }
  })()`)
  ok('★行号在自己那一列里(宽 40 · 右对齐),正文另起一格',
    lnCol && lnCol.w === 40 && lnCol.align === 'right' && lnCol.sibStartsWith === '  con', JSON.stringify(lnCol))
  await p.clickContaining('读取', '477–481')
  await wait(400)

  // ── ④ 超长输出:必须如实说截断了多少 ───────────────────────────────────────
  // ★同样有两张「执行」卡(npm test / npm run typecheck),按命令定位。
  await p.clickContaining('执行', 'npm test -- ipc')
  await wait(700)
  t = await p.text()
  ok('★截断如实说出来(不是静默吞掉)', /只显示前 200 行/.test(t) && /还有 100 行没显示/.test(t) && /共 300 行/.test(t),
    t.split('\n').filter((l) => l.includes('只显示前')).join(' / '))
  await p.shot(S + '/shots/t-03-truncated.png')
  await p.clickContaining('执行', 'npm test -- ipc')
  await wait(400)

  // ── ⑤ provider 什么都没给的那张:如实说,不能编 ────────────────────────────
  await p.clickContaining('编辑', 'handlers.test.ts')
  await wait(500)
  t = await p.text()
  ok('★没有输出就说没有输出', t.includes('这个工具没有回传输出'),
    t.split('\n').filter((l) => l.includes('没有回传')).join(' / '))

  // ── ⑥ 轮次分隔线 ──────────────────────────────────────────────────────────
  const sepInfo = await p.eval(`(() => {
    const t=document.body.innerText
    const seps=[...t.matchAll(/(今天|昨天)\\s\\d{2}:\\d{2}/g)].map(m=>m[0])
    return { seps, msgCount: (t.match(/Claude Code/g)||[]).length }
  })()`)
  ok('分隔线出现了', sepInfo.seps.length >= 1, JSON.stringify(sepInfo.seps))
  ok('★两轮对话只有两根线,不是每条消息一根', sepInfo.seps.length === 2, JSON.stringify(sepInfo.seps))
  ok('★分隔线的时刻来自用户那条消息(23:04 / 23:41),不是回复的时间',
    sepInfo.seps.join(' ').includes('23:04') && sepInfo.seps.join(' ').includes('23:41'), JSON.stringify(sepInfo.seps))

  // 两条细线 + 中间文字的版式
  const sepGeom = await p.eval(`(() => {
    const all=[...document.querySelectorAll('div')]
    const row=all.find(e=>/^(今天|昨天) \\d{2}:\\d{2}$/.test((e.textContent||'').trim()) && e.children.length===3)
    if(!row) return null
    const kids=[...row.children]
    const cs=getComputedStyle(kids[0])
    return { lines: kids.filter(k=>k.getBoundingClientRect().height<=1.5).length, h: kids[0].getBoundingClientRect().height, bg: cs.backgroundColor }
  })()`)
  ok('★分隔线是「细线—时间—细线」三段', sepGeom && sepGeom.lines === 2, JSON.stringify(sepGeom))
  await p.shot(S + '/shots/t-04-seps.png')

  // ── ⑦ 实时:start(运行中)→ done(打勾),同一张卡原地更新 ─────────────────
  mock.stdin.write('tools\n')
  // 假 daemon 1.5 秒后才发 done,所以这一刻卡片必须已经在了 —— 「不用等它结束就看得见」正是这条要验的。
  const appeared = await p.waitFor(`document.body.innerText.includes('npm run build')`, 1200)
  const live1 = await p.eval(`(() => {
    const t=document.body.innerText
    return { has: t.includes('npm run build'), cards: (t.match(/npm run build/g)||[]).length, tick: /npm run build[^\\n]*✓/.test(t) }
  })()`)
  ok('工具一开始跑就出现了(不用等它结束)', appeared && live1.has, JSON.stringify(live1))
  ok('运行中还没有勾', !live1.tick, JSON.stringify(live1))
  await p.shot(S + '/shots/t-05-running.png')

  await p.waitFor(`/npm run build[^\\n]*✓/.test(document.body.innerText)`, 6000)
  const live2 = await p.eval(`(() => {
    const t=document.body.innerText
    return { cards: (t.match(/npm run build/g)||[]).length, out: t.includes('built in 4.2s') }
  })()`)
  ok('★start + done 是同一张卡,不是两张', live2.cards === 1, `出现 ${live2.cards} 次`)
  await p.clickContaining('执行', 'npm run build')
  ok('结束后展开看得到输出', await p.waitFor(`document.body.innerText.includes('built in 4.2s')`, 3000))
  await p.shot(S + '/shots/t-06-done.png')

  // ── ⑧ 浅色也要能看 ────────────────────────────────────────────────────────
  await p.setScheme('light')
  await wait(700)
  // ★底色不在 <body> 上 —— RN-web 把它画在根容器里。量那个铺满视口的 div。
  const lightColors = await p.eval(`(() => {
    const full=[...document.querySelectorAll('div')].filter(e=>{
      const r=e.getBoundingClientRect()
      return r.width>=380 && r.height>=800
    })
    const bgs=full.map(e=>getComputedStyle(e).backgroundColor).filter(b=>b&&b!=='rgba(0, 0, 0, 0)')
    const card=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').includes('477–481'))
      .sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})[0]
    return { bgs: bgs.slice(0,3), text: card ? getComputedStyle(card).color : null }
  })()`)
  // 浅色 bg = #f5f7f9 = rgb(245, 247, 249)
  ok('浅色主题切过去了', lightColors.bgs.some((b) => /245, 247, 249/.test(b)), JSON.stringify(lightColors))
  await p.shot(S + '/shots/t-07-light.png')

  console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条没过`)
} catch (e) {
  bad++
  console.log('FAIL  脚本自己挂了 — ' + (e && e.message ? e.message : e))
} finally {
  // ★收尾必须无条件跑。中间抛一下就把 Chrome 留在 9333 上,下一次跑会连上那个残留的浏览器,
  //  于是断言开始随机变红 —— 上面 launch() 里那道检查就是为这个加的。
  try { await p?.close() } catch { /* 已经断了 */ }
  try { chrome?.kill() } catch { /* 已经没了 */ }
  try { mock?.kill() } catch { /* 已经没了 */ }
}
process.exit(bad === 0 ? 0 : 1)
