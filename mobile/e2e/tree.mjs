/*
 * 第四轮真机反馈的三件事,在**真浏览器**里量一遍。
 *
 * ★为什么必须来这儿量:这三件事有两件是**布局**,而布局在 node/jsdom 下根本量不到
 *  (这也是 `app/index.tsx` 的 absY 一整段注释在说的事)。树画得对不对 ——
 *  竖线连不连得上、拐弯在不在行的正中、最后一行有没有把主干收住、卡片有没有被挤出屏幕 ——
 *  纯逻辑单测一条都答不了。`tree.ts` 的单测钉的是**几个数和规则**,这里钉的是**画出来真是那样**。
 *
 * 量的办法:树的每一段都是一个 1px 宽/高的实色小块,所以直接从 DOM 里按几何把它们捞出来
 * (RN-web 把 View 渲染成 div),不给生产代码加任何测试专用的标记。
 *
 * 跑法:先 `npm run --prefix mobile web`(Metro 要在 :8081),再 `node e2e/tree.mjs`。
 * 上一趟跑挂过的话先 `pkill -f mock-daemon.mjs; pkill -f remote-debugging-port=9333`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
let bad = 0
const ok = (l, c, e = '') => {
  if (!c) bad++
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)
}
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol

// `gate-confirm`:alpha/s-a1 挂着一道门 —— 顶部「需要你」那一块因此真有东西可列。
// alpha 有两条会话(一条中间 `├─` 一条收尾 `└─`),beta 只有一条(只有 `└─`),两档都在。
const mock = await startMock(6813, 'gate-confirm')

const chrome = await launch(S + '/chrome-tree')
const p = await attach()
await p.setViewport(390, 844)

const visible = (text) =>
  `[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)`

await p.goto('http://localhost:8081/')
await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 180000)
await p.eval('localStorage.clear()')
await p.goto('http://localhost:8081/')
await p.waitFor(`document.body.innerText.includes('先连一台电脑')`, 60000)
await p.clickText('添加主机')
await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 15000)
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6813')
await p.clickText('保存并连接')
await p.waitFor(`document.body.innerText.includes('已配对')`, 25000)
// ★2026-08-29:保存完落在【主机】tab,不再是被推进来的次级屏 —— 没有 `‹` 了(tab 没有
//  「上一层」)。回会话列表现在是切 tab,不是退栈。
await p.clickText('会话')
await p.waitFor(visible('alpha'), 20000)

// ── ① 树 ────────────────────────────────────────────────────────────────
await p.clickText('alpha')
await p.waitFor(visible('修 gate 重复放行'), 10000)
await new Promise((r) => setTimeout(r, 600))
await p.shot(S + '/shots/tree-01-alpha.png')

/** 会话卡的矩形:从标题那个元素往上走,第一个高度 ≥ 44 的祖先就是那张卡(`Row` 的 minHeight 是 54)。 */
const cardOf = async (title) => JSON.parse(await p.eval(`(() => {
  const t=[...document.querySelectorAll('*')].filter(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(title)}&&e.getBoundingClientRect().width>0).pop()
  if(!t) return 'null'
  let e=t
  while(e && e.getBoundingClientRect().height < 44) e=e.parentElement
  const r=e.getBoundingClientRect()
  return JSON.stringify({left:r.left,right:r.right,top:r.top,bottom:r.bottom,mid:r.top+r.height/2})
})()`))

/** 屏上所有的树枝小块。竖的:宽 ≤2 且高 ≥3;横的:高 ≤2 且宽 ≥3。 */
const segs = async () => JSON.parse(await p.eval(`(() => {
  const out={v:[],h:[]}
  for(const e of document.querySelectorAll('div')){
    if(e.children.length) continue
    const r=e.getBoundingClientRect()
    const bg=getComputedStyle(e).backgroundColor
    if(bg==='rgba(0, 0, 0, 0)'||!bg) continue
    if(r.width>0.4&&r.width<=2.5&&r.height>=3) out.v.push({x:r.left,top:r.top,bottom:r.bottom})
    else if(r.height>0.4&&r.height<=2.5&&r.width>=3) out.h.push({y:r.top,left:r.left,right:r.right})
  }
  out.v.sort((a,b)=>a.top-b.top); out.h.sort((a,b)=>a.y-b.y)
  return JSON.stringify(out)
})()`))

const c1 = await cardOf('修 gate 重复放行')
const c2 = await cardOf('加 Windows 打包脚本')
ok('两张会话卡都量到了', !!c1 && !!c2, JSON.stringify({ c1, c2 }))

const drawerTop = Math.min(c1.top, c2.top) - 40
const drawerBottom = Math.max(c1.bottom, c2.bottom) + 60
const all = await segs()
const v = all.v.filter((s) => s.bottom > drawerTop && s.top < drawerBottom)
const h = all.h.filter((s) => s.y > drawerTop && s.y < drawerBottom && s.right < c1.left + 2)

// ★一行一段主干:行齐平之后(rowGap 和 TreeGap 都没了)每一行的连接列就是 top:0→bottom:0
//  的**一段**,alpha 这个 fixture 固定两条会话 ⇒ 恒为 2。
//  ★★用**精确计数**而不是 `>= 1`:旁边那条「每张卡各有一根横杠」本来就是精确的,
//   而且精确计数还能抓住反方向的回归 —— 有人把某种行间隙补丁加回来,段数就会变多,
//   `>=` 那种写法对此完全无感。真正保证「主干是一条线」的是下面两条(同一个 x、连续)。
ok('★一行一段主干,而且一段都不少', v.length === 2, JSON.stringify(v))
ok('★每张卡各有一根横杠', h.length === 2, JSON.stringify(h))

const xs = [...new Set(v.map((s) => s.x.toFixed(1)))]
ok('★主干每一段都在同一个 x 上(歪一点点就是一条断掉的竖线)', xs.length === 1, xs.join(' / '))

// 连续性:按 top 排好之后,前一段的下沿必须接上后一段的上沿。
let gapMax = 0
for (let i = 1; i < v.length; i++) gapMax = Math.max(gapMax, v[i].top - v[i - 1].bottom)
ok('★★主干是连的,不是一截一截的(卡片之间那道缝也补上了)', gapMax <= 0.6, `最大断口 ${gapMax.toFixed(2)}px`)

const trunkTop = Math.min(...v.map((s) => s.top))
const trunkBottom = Math.max(...v.map((s) => s.bottom))
ok('★主干从第一条会话的上沿长下来(行齐平了,不再有 rowGap 那 8px)',
  near(trunkTop, c1.top, 1.5), `主干顶 ${trunkTop.toFixed(1)} / 第一张卡顶 ${c1.top.toFixed(1)}`)

const last = c1.bottom > c2.bottom ? c1 : c2
const first = last === c1 ? c2 : c1
ok('★★主干在**最后一条会话**的中点收住(`└─`),不再往下悬着',
  near(trunkBottom, last.mid, 1.5), `主干底 ${trunkBottom.toFixed(1)} / 末行中点 ${last.mid.toFixed(1)}`)

const hFirst = h.find((s) => near(s.y, first.mid, 3))
const hLast = h.find((s) => near(s.y, last.mid, 3))
ok('★横杠挂在每一行的**垂直中点**(行有多高都不用知道)', !!hFirst && !!hLast,
  JSON.stringify({ h, mids: [first.mid, last.mid] }))
if (hFirst && hLast) {
  ok('横杠左端就是主干', near(hFirst.left, Number(xs[0]), 1.2) && near(hLast.left, Number(xs[0]), 1.2))
  ok('★横杠一直画到卡片跟前(气口 = gap + 线宽 = 5px,横杠从主干那一格起画好填上拐角),不是悬在半空',
    near(first.left - hFirst.right, 5, 1) && near(last.left - hLast.right, 5, 1),
    `气口 ${(first.left - hFirst.right).toFixed(1)} / ${(last.left - hLast.right).toFixed(1)}`)
}

// ★全出血:内容区从连接列右侧(44)一直铺到屏幕右沿(390)。
//  旧断言是 `> 340 && < 372` —— 那是「抽屉有 12pt 外边距 + List 有 10pt 右内边距」时代的界线。
//  ★仍然不能只判「小于等于 390」:去掉 `flex: 1` 之后盒子会缩成内容宽,那也小于 390(实测假绿过)。
//  真正的界线是**必须真的顶到 390**。
ok('★★内容区从连接列右侧一直铺到屏幕右沿',
  near(c1.right, c2.right, 0.6) && near(c1.right, 390, 1.2),
  `右沿 ${c1.right.toFixed(1)} / ${c2.right.toFixed(1)}`)

// ＋ 新建会话:和卡片左沿对齐,但**不在树上**。
// ★`ActionRow` 里的 ＋ 是一个独立的 `<Icon>` 元素,不再和文字同属一个 `<T>`,所以按
//  `textContent === '＋ 新建会话'` 去找会一个元素都找不到。改成只匹配 `新建会话`。
// ★往上走到高度 ≥32 的祖先,量到的是 `ActionRow` 的 `actionBody`(`minHeight: 46`,
//  左沿正好是 44)—— 这就是为什么那 44pt 必须是一个真的空 `View` 而不是 `paddingLeft`。
const plus = JSON.parse(await p.eval(`(() => {
  const t=[...document.querySelectorAll('*')].filter(x=>x.textContent&&x.textContent.trim()==='新建会话'&&x.getBoundingClientRect().width>0).pop()
  if(!t) return 'null'
  let e=t
  while(e && e.getBoundingClientRect().height < 32) e=e.parentElement
  const r=e.getBoundingClientRect(); return JSON.stringify({left:r.left,top:r.top,bottom:r.bottom,mid:r.top+r.height/2})
})()`))
ok('「＋ 新建会话」在', !!plus)
if (plus) {
  ok('★它和会话卡左沿对齐(缩进 = 连接列宽)', near(plus.left, c1.left, 1.5), `${plus.left.toFixed(1)} vs ${c1.left.toFixed(1)}`)
  ok('★★它**不在树上**:那一行的中点上没有横杠,主干也没伸到它那儿',
    !all.h.some((s) => near(s.y, plus.mid, 4) && s.right < plus.left + 2) && trunkBottom < plus.top,
    `主干底 ${trunkBottom.toFixed(1)} / 按钮顶 ${plus.top.toFixed(1)}`)
}

// beta 只有一条会话:那一条既是第一条也是最后一条,主干只能是「从上沿到它的中点」。
await p.clickText('beta')
await p.waitFor(visible('迁移评论表到 v2'), 10000)
await new Promise((r) => setTimeout(r, 500))
const cb = await cardOf('迁移评论表到 v2')
const sb = await segs()
const vb = sb.v.filter((s) => s.top > cb.top - 20 && s.bottom < cb.bottom + 20 && s.x < cb.left)
const bBottom = vb.length ? Math.max(...vb.map((s) => s.bottom)) : -1
ok('★只有一条会话时,主干从上沿一路到它的中点为止', vb.length >= 1 && near(bBottom, cb.mid, 1.5),
  `主干底 ${bBottom.toFixed(1)} / 中点 ${cb.mid.toFixed(1)}`)
await p.shot(S + '/shots/tree-02-beta.png')

// ── ② 「需要你」折叠 ─────────────────────────────────────────────────────
await p.goto('http://localhost:8081/')
await p.waitFor(visible('alpha'), 30000)
await new Promise((r) => setTimeout(r, 800))
let t = await p.text()
const headRe = /\d+ 条等你( · \d+ 道门)?/
const head = (t.match(headRe) || [''])[0]
// ★「这一块的列表在不在」**不能**用会话标题去判:同一个标题在下面那个展开着的工作区抽屉里也有一份,
//  拿它判会一直是「还在」。副行那句「等了 mm:ss」是这一块**独有**的(抽屉里的行报的是相对时间)。
const ROWS = /等了 \d\d:\d\d/
ok('★顶部「需要你」在,而且头上带着数', !!head && head.includes('道门'), head)
ok('展开时列着具体是哪几条(带着「等了多久」)', ROWS.test(t) && t.includes('修 gate 重复放行'))
await p.shot(S + '/shots/tree-03-needsyou-open.png')

await p.clickText('❓ ' + head)
await new Promise((r) => setTimeout(r, 500))
t = await p.text()
ok('★★折起来之后**头还在,数还在**(折叠只准藏细节,不准藏「有事等你」这个事实)',
  t.includes(head), t.split('\n').slice(0, 8).join(' / '))
ok('★列表真的收起来了', !ROWS.test(t))
await p.shot(S + '/shots/tree-04-needsyou-folded.png')

await p.goto('http://localhost:8081/')
await p.waitFor(visible('alpha'), 30000)
await new Promise((r) => setTimeout(r, 1500))
t = await p.text()
ok('★★重开一次还是折着的(折叠是姿态,得存盘)', t.includes(head) && !ROWS.test(t),
  t.split('\n').slice(0, 8).join(' / '))

await p.clickText('❓ ' + head)
await new Promise((r) => setTimeout(r, 400))
t = await p.text()
ok('再点一下又展开', ROWS.test(t))

// ── ③ 关于:自己一屏 ─────────────────────────────────────────────────────
const appJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'app.json'), 'utf8'))
await p.goto('http://localhost:8081/settings')
await p.waitFor(`document.body.innerText.includes('外观')`, 30000)
t = await p.text()
ok('★设置屏里「关于」只剩一行(版本号不在这一屏上了)', !t.includes('手机端版本'), t.split('\n').slice(0, 30).join(' / '))
await p.clickText('关于')
await new Promise((r) => setTimeout(r, 700))
t = await p.text()
ok('★★点进去是**一屏**,不是原地展开', t.includes('连不上的时候,先看这三个数'), t.split('\n').slice(0, 6).join(' / '))
ok('★手机端版本报的是 app.json 里那一个', t.includes(appJson.expo.version), `期望 ${appJson.expo.version}`)
ok('主机版本和方法数都在(连着,所以是真数)', t.includes('主机版本') && t.includes('主机提供的方法') && !t.includes('连上才知道'))
ok('★没编任何链接(官网 / 更新日志 / 开源许可都不存在)', !/官网|更新日志|许可|GitHub/.test(t))
await p.shot(S + '/shots/tree-05-about.png')

await p.clickText('‹')
await new Promise((r) => setTimeout(r, 500))
t = await p.text()
ok('返回回得去设置屏', t.includes('外观 · 跟着这台手机走'))

console.log(bad ? `\n${bad} 条红` : '\n全绿')
p.close()
chrome.kill()
mock.kill()
process.exit(bad ? 1 : 0)
