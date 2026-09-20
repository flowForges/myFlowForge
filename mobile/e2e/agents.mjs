/*
 * 子代理卡 + 委派批次卡的端到端。
 *
 * 两类东西来路不同,所以走两条路验:
 *  · 内置子代理(Task)—— **落档**在消息上,从历史里就能拿到
 *  · 委派批次(forge_delegate)—— **不落档**,只能从实时流里来
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

const mock = await startMock(6810, 'none')
let chrome, p
try {
  chrome = await launch(S + '/chrome-agents')
  p = await attach()
  await p.setViewport(390, 844)
  await p.goto('http://localhost:8081/add-host')
  await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 60000)
  await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6810')
  await p.clickText('保存并连接')
  await p.waitFor(`document.body.innerText.includes('找出所有权限门的入口')`, 20000)

  // ── ① 内置子代理:从历史里就该有 ────────────────────────────────────
  let t = await p.text()
  ok('子代理卡从历史里就画出来了', t.includes('找出所有权限门的入口') && t.includes('补 handlers 的单测'),
    t.split('\n').filter((l) => l.includes('权限门')).join(' / '))
  ok('标题是「类型 · 描述」', t.includes('Explore · 找出所有权限门的入口'))
  ok('★汇总行单独说了几个在跑 —— 光说「3 个」看不出还有没有人在动',
    /3 个子代理 · 1 个在跑 · 1 个失败/.test(t), t.split('\n').filter((l) => l.includes('子代理')).join(' / '))
  ok('★还在跑的那张显示它最近一步在干什么', t.includes('调用 Bash: npm test -- ipc'),
    t.split('\n').filter((l) => l.includes('npm test')).join(' / '))
  ok('跑完的打勾、失败的打叉', t.includes('✓') && t.includes('✗'))
  ok('★折叠时结果不露出来', !t.includes('handlers.ts:479'))
  await p.shot(S + '/shots/a-01-subagents.png')

  // 运行中那张的边框该是强调色(原型 `.tool.running`),不是普通边框
  const borders = await p.eval(`(() => {
    const pick=(sub)=>{
      const hits=[...document.querySelectorAll('*')].filter(e=>(e.textContent||'').includes(sub)&&e.getBoundingClientRect().height>0)
      if(!hits.length) return null
      let n=hits.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})[0]
      for(let i=0;i<5&&n;i++){const cs=getComputedStyle(n); if(cs.borderTopLeftRadius!=='0px') return cs.borderTopColor; n=n.parentElement}
      return 'none'}
    return { running: pick('补 handlers 的单测'), doneCard: pick('找出所有权限门的入口') }
  })()`)
  // 深色下 toolRunBorder = #405373 = rgb(64, 83, 115),普通边框 = #26292d = rgb(38, 41, 45)
  ok('★运行中那张卡的边框是强调色(量的 computed style)', /64, 83, 115/.test(borders.running ?? ''), JSON.stringify(borders.running))
  ok('已完成那张是普通边框', /38, 41, 45/.test(borders.doneCard ?? ''), JSON.stringify(borders.doneCard))

  // ── ② 展开:跑完看结果,还在跑看最近几步 ─────────────────────────────
  await p.clickContaining('Explore · 找出所有权限门的入口')
  await p.waitFor(`document.body.innerText.includes('handlers.ts:479')`, 5000)
  ok('展开跑完的那张看到结果', (await p.text()).includes('handlers.ts:479'))
  await p.clickContaining('general-purpose · 补 handlers 的单测')
  await p.waitFor(`document.body.innerText.includes('调用 Grep') || document.body.innerText.includes('handlers.test.ts')`, 5000)
  t = await p.text()
  ok('★展开还在跑的那张看到的是它走过的步子,不是空话',
    t.includes('调用 Read src/main/ipc/handlers.test.ts'), t.split('\n').filter((l) => l.includes('handlers.test')).join(' / '))
  await p.shot(S + '/shots/a-02-expanded.png')

  // ── ③ 委派批次:实时来的 ───────────────────────────────────────────
  mock.stdin.write('delegate\n')
  const appeared = await p.waitFor(`document.body.innerText.includes('go-blog')`, 3000)
  // ★主轮次**先 done**(fire-and-forget 就是这样),子代理之后才回报。
  //  done 那一刀如果把实时攒的委派卡冲掉,后面所有进度就都无处可去 —— 所以先钉住它还在。
  const survivedDone = await p.waitFor(
    `document.body.innerText.includes('跑完汇总给你') && document.body.innerText.includes('go-blog')`, 4000)
  ok('★主轮次 done 之后,还在跑的委派卡没有被落档那份冲掉', survivedDone,
    'delegates 是纯实时的,done 带的那条消息里根本没有 —— 必须从流式那份接过来')
  t = await p.text()
  ok('委派批次一发出来就看得见', appeared && t.includes('go-blog') && t.includes('zgh') && t.includes('website'),
    t.split('\n').filter((l) => l.includes('go-blog')).join(' / '))
  // 三个里 d1 已经回报完成了,所以是 2 个在跑 —— 这一条顺带钉住「状态真的翻过去了」。
  ok('汇总说清派了几个、几个在跑', /委派 · 3 个子代理 · 2 个在跑/.test(t),
    t.split('\n').filter((l) => l.includes('委派')).join(' / '))
  ok('把派下去的任务本身也显示出来', t.includes('把三个项目的登录都换成新的 token 校验'))
  await p.shot(S + '/shots/a-03-delegate.png')

  // ★★这一拍验的是**同一个子代理**的第二条 progress(只带 activity 不带 output)
  //    有没有把第一条送到的 output 抹掉。不同子代理之间验不出这个 —— map 只改 agentId 对上的那个。
  await p.waitFor(`document.body.innerText.includes('在收尾')`, 5000)
  // ★「当前在做什么」这一行只在 status 还是 run 的时候画,所以**先断言它**,再去做点击那些慢动作 ——
  //  反过来的话这条断言就是在和 mock 的下一拍赛跑,红了也不代表实现坏了。
  const sawActivity = await p.waitFor(`document.body.innerText.includes('正在改 service/auth.go')`, 5000)
  ok('还在跑的那个显示它当前在做什么', sawActivity)
  await p.clickContaining('go-blog · codex')
  const kept = await p.waitFor(`document.body.innerText.includes('go-blog 改完,3 个文件')`, 4000)
  ok('★同一个子代理的第二条 progress(只带 activity)没有把上一条的 output 抹掉', kept,
    '照单全收会把已经送到的结果覆盖成 undefined')

  // 全部结束 —— 由脚本说了算,不是等一个定时器
  mock.stdin.write('delegate-finish\n')
  await p.waitFor(`document.body.innerText.includes('1 个没跑成')`, 5000)
  t = await p.text()
  ok('★批次结束时不说「全部完成」—— 有一个没跑成就要说出来',
    /委派 · 3 个子代理 · 1 个没跑成/.test(t) && !t.includes('都结束了'),
    t.split('\n').filter((l) => l.includes('委派')).join(' / '))
  await p.shot(S + '/shots/a-04-delegate-done.png')

  // ── ④ 内置子代理的**实时**那一路(前面三张走的是落档那一路)────────────
  mock.stdin.write('subagent\n')
  const liveSub = await p.waitFor(`document.body.innerText.includes('实时起的子代理')`, 4000)
  ok('★实时 subagent 事件也画得出来(不只是从历史里读)', liveSub)
  await p.waitFor(`document.body.innerText.includes('调用 Grep: registerIpc')`, 4000)
  ok('运行中显示它最近一步', (await p.text()).includes('调用 Grep: registerIpc'))
  const finished = await p.waitFor(`/实时起的子代理[\\s\\S]{0,40}✓/.test(document.body.innerText)`, 4000)
  ok('★start 和 done 是同一张卡,不是两张',
    finished && (await p.eval(`(document.body.innerText.match(/实时起的子代理/g)||[]).length`)) === 1)
  await p.clickContaining('Explore · 实时起的子代理')
  ok('跑完展开看到结果', await p.waitFor(`document.body.innerText.includes('只有一处')`, 4000))
  await p.shot(S + '/shots/a-05-live-subagent.png')

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
