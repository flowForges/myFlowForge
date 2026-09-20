import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { openChat, plusMenu, startMock } from './harness.mjs'

/**
 * 在手机上**改工作流本身**:删阶段 / 加阶段 / 换名字 → 保存 → 回启动屏看见改动;
 * 再新建一条、用它启动;最后删掉。
 *
 * ★★这一屏和启动屏最容易混:一个改这一次,一个改以后每一次。所以第一条断言就是
 *  「界面上说清了这是改工作流本身」—— 那句话不是文案洁癖,它是两屏唯一的区别标识。
 * ★往返是真的往返:假 daemon 把 `workspace:save-workflow` 存进 `LAUNCH_FLOWS`,
 *  启动屏再从 `run2:launch-info` 读回来。存了没生效 / 存到别处去了,这里就会红。
 * ★假 daemon 的保存照抄了主机那边的**合并**语义(手机没发的字段不许丢),
 *  所以「保存完把提示词抹了」这类错在这里也照得出来。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
let failed = 0
const ok = (l, c, e = '') => { if (!c) failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`) }

const mock = await startMock(6811, 'plain')
const chrome = await launch(S + '/chrome-fe')
const p = await attach()

/** 等不到就**抛**。等不到还往下走的话,后面每一条断言验的都是上一屏 —— 全是假红/假绿。 */
const must = async (expr, ms, what) => {
  if (!(await p.waitFor(expr, ms))) throw new Error(`等不到${what}:` + (await p.text()).split('\n').slice(0, 60).join(' / '))
}
const has = (text) => `document.body.innerText.includes(${JSON.stringify(text)})`

/**
 * 点某一行**里面**的那颗小键(✎ / ✕)。
 * ★不能用 clickText:同一个字形一屏有好几个,它取最后一个 —— 于是删的是另一行。
 * ★也不能用 clickContaining:它点的是「含这两段文字的最小元素」的左侧,那还是整行(= 选中,不是编辑)。
 */
async function clickIn(rowText, glyph) {
  const box = await p.eval(`(() => {
    const g=${JSON.stringify(glyph)}
    const rows=[...document.querySelectorAll('*')]
      .filter(e=>(e.textContent||'').includes(${JSON.stringify(rowText)}) && [...e.querySelectorAll('*')].some(x=>(x.textContent||'').trim()===g))
      .sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height})
    const row=rows[0]; if(!row) return null
    const e=[...row.querySelectorAll('*')].filter(x=>(x.textContent||'').trim()===g).pop()
    e.scrollIntoView({block:'center',inline:'nearest'})
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}
  })()`)
  if (!box) throw new Error(`「${rowText}」这一行里找不到 ${glyph}`)
  // (clickIn 自己的 eval 里已经把行滚进了视口 —— 见 cdp.mjs click() 那段注释)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 300))
}

await p.setViewport(390, 844)
await openChat(p, 6811)
await plusMenu(p, '工作流')
await must(has('选一个工作流'), 10000, '启动屏')

let t = await p.text()
ok('启动屏列出工作流,并且报了阶段数', t.includes('标准流') && t.includes('4 个阶段'), t.match(/\d+ 个阶段/g)?.join(' / '))
ok('每条工作流末尾有编辑入口', t.includes('编辑'))
await p.shot(S + '/shots/fe-01-launch.png')

// ── 改一条已有的 ────────────────────────────────────────────────────────────
await clickIn('标准流', '✎')
await must(has('编辑工作流'), 10000, '编辑屏')
t = await p.text()
ok('★界面上说清了这是改工作流本身(和启动屏的「只改这一次」分得开)',
  t.includes('改的是工作流本身') && t.includes('电脑端同步生效'), t.split('\n').slice(0, 8).join(' / '))
ok('阶段都在,顺序是服务端那一份', /需求评估[\s\S]*技术方案设计[\s\S]*代码开发[\s\S]*写单测/.test(t))
ok('代码开发标了「按项目跑」(主机给的,手机不给改)', t.includes('按项目跑'))
ok('带门的阶段显示的是「跑完停下来等确认」', t.includes('跑完停下来等确认'))
ok('没改动时保存键是「没有改动」', t.includes('没有改动'))
await p.shot(S + '/shots/fe-02-edit.png')

await clickIn('写单测', '✕')
await must(has('3 个阶段'), 6000, '删完之后的计数')
t = await p.text()
ok('删掉一个阶段:计数跟着变,「写单测」没了', t.includes('3 个阶段') && !t.includes('写单测'))
ok('改动之后保存键活了', !t.includes('没有改动'))

await p.clickText('加一个阶段')
await must(has('内置阶段'), 6000, '阶段单子')
t = await p.text()
ok('单子里内置和自定义分开列', t.includes('内置阶段') && t.includes('自定义阶段库') && t.includes('补文档'))
ok('★已经在流程里的置灰并说明原因,而不是点了没反应', t.includes('已在流程里'))
await p.shot(S + '/shots/fe-03-addstage.png')
await p.clickText('代码 CR')
await must(has('4 个阶段'), 6000, '加完之后的计数')
t = await p.text()
ok('加完回到编辑屏,新阶段在最后', t.includes('代码 CR') && t.includes('4 个阶段'))

await p.clickText('保存')
await must(has('选一个工作流'), 10000, '存完回启动屏')
const stageLine = await p.eval(`(() => {
  const t=document.body.innerText.split('\\n'); const i=t.findIndex(l=>l.trim()==='标准流')
  return i<0?'':t[i+1].trim()
})()`)
ok('★存完回启动屏,标准流还是 4 个阶段(删一个加一个)', stageLine === '4 个阶段', stageLine)
t = await p.text()
ok('★往返:启动屏的流程一节换成了改完的阶段', t.includes('代码 CR') && !t.includes('写单测'))
await p.shot(S + '/shots/fe-04-after-save.png')

// ── 新建一条,然后用它启动 ───────────────────────────────────────────────────
await p.clickText('新建')
await must(has('新建工作流'), 10000, '新建屏')
t = await p.text()
ok('新建屏是空的,并且说了为什么不能存', t.includes('先给这条工作流起个名字'))
await p.typeInto('input[placeholder*="只开发"]', '只开发')
await must(has('至少留一个阶段'), 6000, '「至少留一个阶段」')
ok('★有名字没阶段时说的是「至少留一个阶段」', true)
await p.clickText('加一个阶段')
await must(has('内置阶段'), 6000, '阶段单子')
await p.clickText('代码开发')
await must(has('1 个阶段'), 6000, '加完之后的计数')
await p.shot(S + '/shots/fe-05-new.png')
await p.clickText('保存')
await must(has('选一个工作流'), 10000, '存完回启动屏')
t = await p.text()
ok('新建的工作流出现在启动屏', t.includes('只开发'))

await p.clickText('只开发')
await p.typeInto('textarea[placeholder*="一句话说清楚"]', '给评论接口加分页')
await new Promise((r) => setTimeout(r, 400))
await p.clickText('启动「只开发」')
// 状态条上的 `1/1` 才算真启动了 —— 只判「屏幕上有『只开发』」的话,启动失败停在启动屏也算过。
await must(`/1\\s*\\/\\s*1/.test(document.body.innerText)`, 10000, '启动之后的状态条')
t = await p.text()
ok('★手机上新建的工作流能真跑起来(不是只存下来好看)', t.includes('代码开发'),
  t.split('\n').slice(0, 4).join(' / '))
await p.shot(S + '/shots/fe-06-launched.png')

// ── 删一条 ──────────────────────────────────────────────────────────────────
await p.clickText('✕')   // 退出工作流,回到能进启动屏的状态
await must(`!!document.querySelector('[aria-label="更多"]')`, 8000, '退回对话屏')
await plusMenu(p, '工作流')
await must(has('只开发'), 10000, '启动屏')
await clickIn('只开发', '✎')
await must(has('编辑工作流'), 10000, '编辑屏')
// ★web 上 confirmDestructive 走的是 window.confirm,它会**阻塞整个页面**(CDP 这头跟着卡住)。
//  所以先把它按成「点了确定」;确认框本身长什么样只能在真机上看。
await p.eval('window.confirm = () => true')
await p.clickText('删除这条工作流')
await must(has('选一个工作流'), 10000, '删完回启动屏')
t = await p.text()
ok('删掉之后启动屏里没有它了', !t.includes('只开发') && t.includes('标准流'))
await p.shot(S + '/shots/fe-07-deleted.png')

console.log(failed ? `\n${failed} 条没过` : '\n全过')
await p.close()
chrome.kill()
mock.kill()
process.exit(failed ? 1 : 0)
