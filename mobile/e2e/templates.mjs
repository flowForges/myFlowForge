import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { openChat, plusMenu, startMock } from './harness.mjs'

/**
 * 第二格的三段(工作区 / 归档 / 工作流),以及**工作流模板库**那一段。
 *
 * ★★这一趟验的核心是一条**真往返**:在模板段点「用到…」→ 挑一个工作区 →
 *  假 daemon 的 `workspace:add-workflow-from-template` 把模板物化进 `LAUNCH_FLOWS` →
 *  切回对话屏、开启动屏,**那条工作流真的能选到**。
 *  只验「点完弹了句成功」的话,「存到别处去了」「存了个空壳」这两类错一条都照不出来。
 * ★假 daemon 那边照抄了真服务端的语义(物化、同名拒绝、模板不存在拒绝),
 *  松一档的话这里验的就是一个比真货宽松的东西 —— 9-4 那次的教训。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
let failed = 0
const ok = (l, c, e = '') => { if (!c) failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`) }

const mock = await startMock(6813, 'plain')
const chrome = await launch(S + '/chrome-tpl')
const p = await attach()

const must = async (expr, ms, what) => {
  if (!(await p.waitFor(expr, ms))) throw new Error(`等不到${what}:` + (await p.text()).split('\n').slice(0, 60).join(' / '))
}
const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`
const visible = (text) =>
  `[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)`

/**
 * 点某一行**里面**的那颗键。
 * ★不能用 clickText:「用到…」一屏有三个,它取最后一个 —— 于是点的是另一条模板。
 */
async function clickIn(rowText, glyph) {
  const box = await p.eval(`(() => {
    const g=${JSON.stringify('用到…')}
    const rows=[...document.querySelectorAll('*')]
      .filter(e=>(e.textContent||'').includes(ROWTEXT) && [...e.querySelectorAll('*')].some(x=>(x.textContent||'').trim()===g))
      .sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})
    const row=rows[0]; if(!row) return null
    const e=[...row.querySelectorAll('*')].filter(x=>(x.textContent||'').trim()===g).pop()
    e.scrollIntoView({block:'center',inline:'nearest'})
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}
  })()`.replace('ROWTEXT', JSON.stringify(rowText)))
  if (!box) throw new Error(`「${rowText}」这一行里找不到 ${glyph}`)
  // (上面那段 eval 已经把行滚进了视口 —— 见 cdp.mjs click() 那段注释:
  //  dispatchMouseEvent 按**视口坐标**投递,滚出视口的元素点了等于点空,而且一声不吭。)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 300))
}

/**
 * 退回到**有底部 tab bar 的那一层**。
 *
 * ★★对话屏、启动屏这些次级屏都在**根栈**里,推出去时盖住 tab bar(见 `app/_layout.tsx`)——
 *  所以从它们那儿直接 `clickText('工作区')` 是找不到的,现象是「找不到文本: 工作区」,
 *  长得像 tab 坏了。一路 `‹` 退到底才算回到 tab 那一层。
 */
async function toTabs(p) {
  for (let i = 0; i < 4; i++) {
    if (await p.eval(`(${visible('会话')}) && (${visible('设置')})`)) return
    await p.clickText('‹')
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('退不回 tab bar:' + (await p.text()).split('\n').slice(0, 8).join(' / '))
}

try {
  await p.setViewport(390, 844)
  await openChat(p, 6813)
  await toTabs(p)

  // ── 进第二格 ────────────────────────────────────────────────────────────────
  await p.clickText('工作区')
  await must(has('归档'), 10000, '第二格')
  let t = await p.text()
  ok('★第二格是三段:工作区 / 归档 / 工作流', t.includes('归档') && t.includes('工作流'),
    t.split('\n').slice(0, 6).join(' / '))
  await p.shot(S + '/shots/tpl-01-tabs.png')

  // ── 归档段(原来是另一屏,现在搬进来了)────────────────────────────────────
  await p.clickText('归档')
  await must(has('没有归档的工作区'), 10000, '归档段')
  ok('归档从独立一屏变成一段,内容还在', (await p.text()).includes('没有归档的工作区'))

  // ── 模板段 ──────────────────────────────────────────────────────────────────
  await p.clickText('工作流')
  await must(has('只写文档'), 10000, '模板库')
  t = await p.text()
  ok('★列出的是**模板库**(这台机器上的三条),不是某个工作区里的工作流',
    t.includes('标准流') && t.includes('快速修复') && t.includes('只写文档'),
    t.split('\n').slice(0, 10).join(' / '))
  ok('★每个模板摊出阶段名,而不是只给个数字 —— 模板之间的区别就在阶段上',
    t.includes('需求评估') && t.includes('代码开发'))
  // ★★模板里对阶段库的引用只缓存了一份**过期的**名字(fixture 里写死的「缓存的旧名字」)。
  //  照它显示的话,这一行写的是一个早就改过名的阶段,而屏幕上完全看不出来。
  ok('★★libId 阶段显示的是阶段库里的真名,不是模板里那份过期缓存',
    t.includes('补文档') && !t.includes('缓存的旧名字'), t.split('\n').slice(0, 12).join(' / '))
  await p.shot(S + '/shots/tpl-02-library.png')

  // ── 用到某个工作区 ──────────────────────────────────────────────────────────
  // ★点「只写文档」那一行的「用到…」——另外两条的名字和工作区里已有的工作流一样,一点就撞名。
  await clickIn('只写文档', '用到…')
  await must(has('加到哪个工作区'), 8000, '挑工作区的单子')
  await p.shot(S + '/shots/tpl-03-picker.png')
  await p.clickText('alpha')
  await must(has('已经加进'), 10000, '加完那句话')
  t = await p.text()
  ok('★加完说清了「然后去哪儿用它」', t.includes('启动工作流时就能选它'),
    t.split('\n').slice(0, 6).join(' / '))

  // ── ★真往返:回对话屏开启动屏,那条工作流必须真的在里面 ────────────────────
  // ★★重新走一遍 `openChat` —— 它清掉 localStorage 重新配对,**确定**落在对话屏。
  //  为什么不自己点回去:离开的屏在 RN-web 上不卸载,「会话」和「工作区」两份 DOM 同时在,
  //  `clickText('alpha')` 取最后一个匹配 = 看不见的那份,点了一声不吭(查了三轮)。
  //  harness 里那句注释说的就是这件事:这条路变过三次,别各抄一份。
  //  ★假 daemon 的 `LAUNCH_FLOWS` 在内存里,重新配对不会把刚加进去的那条冲掉 ——
  //   所以这一趟仍然是**真往返**。
  await openChat(p, 6813)
  await plusMenu(p, '工作流')
  await must(has('选一个工作流'), 10000, '启动屏')
  t = await p.text()
  ok('★★从模板加进去的那条,启动屏里真的选得到(不是只弹了句成功)',
    t.includes('只写文档'), t.split('\n').slice(0, 12).join(' / '))
  await p.shot(S + '/shots/tpl-04-launcher.png')

  // ── 同名再加一次:必须被拒,并且说清原因 ────────────────────────────────────
  await toTabs(p)
  await p.clickText('工作区')
  await must(has('归档'), 10000, '第二格')
  await p.clickText('工作流')
  await must(has('只写文档'), 10000, '模板库')
  await clickIn('只写文档', '用到…')
  await must(has('加到哪个工作区'), 8000, '挑工作区的单子')
  await p.clickText('alpha')
  await must(has('已经有一条'), 10000, '重名的拒绝')
  t = await p.text()
  ok('★重名不是静默多一条,而是当面说清', t.includes('已经有一条叫'),
    t.split('\n').slice(0, 6).join(' / '))
  await p.shot(S + '/shots/tpl-05-duplicate.png')
} catch (e) {
  failed++
  console.log('FAIL  跑挂了 — ' + (e && e.message ? e.message : String(e)))
}

console.log(failed ? `\n${failed} 条没过` : '\n全过')
await p.close()
chrome.kill()
mock.kill()
process.exit(failed ? 1 : 0)
