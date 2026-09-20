/*
 * 门上的「👁 看看」只准出现在**变更页拉得到的那份 diff 真是这道门的依据**时。
 *
 * ★★为什么值得单开一个脚本:对话屏在本会话没门时会**从别的工作区借**一道门钉着
 *  (那行「这道门来自另一个会话」是故意的、先于这条分支存在)。而 `app/exec.tsx` 的变更是按
 *  **你正在看的会话**的 wsPath 拉的。两者对不上时点「看看」,屏幕上是 W1 的 diff、
 *  底下钉着 W2 的门、「允许」就在旁边 —— 唯一的破绽是顶栏写 W1 而门上写「位置 W2」。
 *  判断本身在 `src/data/gatePeek.ts` 里有单测;这个脚本钉的是**接线**:
 *  那个判断有没有真接到这颗按钮上,以及借来的那一档界面上到底长什么样。
 *
 * 跑法:先 `npm run --prefix mobile web`(Metro 要在 :8081),再 `node e2e/gatepeek.mjs`。
 * 上一趟跑挂过的话先 `pkill -f mock-daemon.mjs; pkill -f remote-debugging-port=9333`。
 *
 * ★变异验证(实跑过):把 `canPeekGate(gate, selected?.wsPath)` 放宽回
 *  `gate.kind === 'confirm'`(也就是这条分支之前的写法)→ **②红**(借来的门上又冒出那颗按钮),
 *  ① 仍绿。反过来把整个 onPeek 去掉 → **①红**、② 绿。两条各验各的一半。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)

// `gate-confirm`:**只有** alpha/s-a1 挂着一道 confirm 门。beta 那边一道门都没有 ——
// 于是进 beta 的会话时,对话屏会把 alpha 那道借过来钉着,正是要验的那一档。
const mock = await startMock(6806, 'gate-confirm')

const chrome = await launch(S + '/chrome-gatepeek')
const p = await attach()
await p.setViewport(390, 844)

/** 分组头带 uppercase,`innerText` 返回渲染后的文本,按 `textContent` 找才准(见 unread.mjs)。 */
const visible = (text) =>
  `[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)`

await p.goto('http://localhost:8081/')
await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 120000)
await p.eval('localStorage.clear()')
await p.goto('http://localhost:8081/')
await p.waitFor(`document.body.innerText.includes('先连一台电脑')`, 60000)
await p.clickText('添加主机')
await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 15000)
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6806')
await p.clickText('保存并连接')
await p.waitFor(`document.body.innerText.includes('已配对')`, 25000)
// ★2026-08-29:主机屏是底部 tab 的一格,没有 `‹` 了 —— 回会话列表是切 tab。
await p.clickText('会话')
await p.waitFor(visible('alpha'), 20000)

// ── ① 门就在你正看的这个区里 → 「看看」必须在 ─────────────────────────────
// 少了它,「按允许之前先看看它改了什么」这条路就退回到「记住这道门、退出去、点顶栏 ≣、再找回来」。
await p.clickText('alpha')
await p.waitFor(visible('修 gate 重复放行'), 10000)
await p.clickText('修 gate 重复放行')
await p.waitFor(`document.body.innerText.includes('执行确认')`, 15000)
let t = await p.text()
ok('★本会话自己的 confirm 门上有「👁 看看」', t.includes('👁 看看'), t.split('\n').filter((l) => l.includes('看看') || l.includes('位置')).join(' / '))
await p.shot(S + '/shots/g-01-own-gate.png')

// ── ② 借来的门 → 「看看」必须**不在** ────────────────────────────────────
// 这一屏拉的是 beta 的变更,而门在 alpha。给错依据比不给更坏。
await p.clickText('‹')
await p.waitFor(visible('alpha'), 15000)
await p.clickText('beta')
await p.waitFor(visible('迁移评论表到 v2'), 10000)
await p.clickText('迁移评论表到 v2')
await p.waitFor(`document.body.innerText.includes('这道门来自另一个会话')`, 15000)
t = await p.text()
ok(
  '★★借来的那道门(在 alpha,而你在 beta)上**没有**「👁 看看」',
  t.includes('这道门来自另一个会话') && !t.includes('👁 看看'),
  t.split('\n').filter((l) => l.includes('另一个会话') || l.includes('看看')).join(' / '),
)
// 借来的那一档不是没出路:那行字本身可点,回列表 —— 列表带工作区上下文,进对的会话再看 diff。
ok('借来的门仍旧给得出一条诚实的路(那行字可点,回列表)', t.includes('这道门来自另一个会话'))
await p.shot(S + '/shots/g-02-borrowed-gate.png')

await p.close()
chrome.kill()
mock.kill()
