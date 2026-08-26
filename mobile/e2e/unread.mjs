/*
 * 跨设备未读 · 两个方向都验。
 *
 * ★★为什么这一屏值得单开一个 e2e,而不是像 `reportSeen.ts` 那样抽个纯函数单测:
 *  **上报**那一半的判断(空 id / 查方法表)确实是纯逻辑,已经抽出来测透了;
 *  但**接收**那一半根本没有判断可抽 —— 它只有一句「`e` 非空就 clearUnread」。
 *  把那句抽成 `shouldClearOnSeen(e)` 再单测,测到的是一个没人会写错的空值守卫,
 *  而真正会坏的三件事一件都碰不到:
 *    ① 订阅的频道名对不对(`CH.chatSeen`);
 *    ② 收到之后清的是不是同一个 key(wsPath/sessionId 两个字段名两端叫法不同);
 *    ③ 屏幕上那颗圆点**真的灭了**。
 *  这三件全活在接线里,只有把真帧喂进真页面才看得见。所以这里选 e2e,不选更省事的单测。
 *
 * 跑法:先 `npm run --prefix mobile web`(Metro 要在 :8081),再 `node e2e/unread.mjs`。
 * 上一趟跑挂过的话先 `pkill -f mock-daemon.mjs; pkill -f remote-debugging-port=9333`。
 *
 * ★变异验证(三条,都实跑过,结果记在这儿免得下次有人怀疑这几条是不是摆设):
 *  · `on(CH.chatSeen, …)` 的频道名改成一个不存在的 → **②红**,其余全绿。
 *  · 删掉「跑完时也上报」那一行 → **③红**(日志里一个新增字节都没有),其余全绿。
 *  · 把那一行放宽成「每一轮跑完都上报」→ **①红** —— 这条是意外收获:
 *    多报的那一次会被主机原样广播回来,刚亮起的未读**当场被自己灭掉**。
 *    也就是说 ① 顺带钉住了「别乱报」,不只是「会报」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const SEEN_LOG = path.join(S, 'mark-seen.log')
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)

// ★脚本用 `quiet`:门会**盖住**未读。分组头的右槽只有一个位置,`app/index.tsx` 里
//  门 > 执行中 > 未读,挂着门的话这一整个脚本验的就是另一档了。
const mock = await startMock(6805, 'quiet')
const seenLog = () => { try { return fs.readFileSync(SEEN_LOG, 'utf8') } catch { return '' } }

const chrome = await launch(S + '/chrome-unread')
const p = await attach()
await p.setViewport(390, 844)

// ★每趟从零开始:AsyncStorage 在 web 上就是 localStorage,上一趟的主机和展开状态会带过来。
await p.goto('http://localhost:8081/')
await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 120000)
await p.eval('localStorage.clear()')
await p.goto('http://localhost:8081/')

await p.waitFor(`document.body.innerText.includes('先连一台电脑')`, 60000)
await p.clickText('添加主机')
await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 15000)
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6805')
await p.clickText('保存并连接')
await p.waitFor(`document.body.innerText.includes('已配对')`, 25000)
await p.clickText('‹')
/**
 * ★分组头带 `textTransform: 'uppercase'`,而 **`innerText` 返回的是渲染后的文本** ——
 *  屏幕上是 `ALPHA`,`innerText.includes('alpha')` 于是永远为假(这条一开始就把我坑了 20 秒)。
 *  `textContent` 不受 text-transform 影响,按它找才对(`flow.mjs` 的 `visible()` 同理)。
 *  顺带排除宽度为 0 的节点:免得把一个还没画出来的节点当成「已经露出来了」。
 */
const visible = (text) =>
  `[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)`
const onList = await p.waitFor(visible('alpha'), 20000)
ok('连上了,落在会话列表', onList, (await p.text()).split('\n').slice(0, 3).join(' / '))

// ── ① 一轮在别处跑完 → 列表上出现未读徽章 ────────────────────────────────
// 这是下面两条的前提:没有一颗真的亮着的圆点,「灭了」是验不出来的。
mock.stdin.write('finish s-a2\n')
const lit = await p.waitFor(`document.body.innerText.includes('未读')`, 10000)
ok('★别处跑完一轮 → 列表上亮起未读', lit, (await p.text()).split('\n').filter((l) => l.includes('未读')).join(' / '))
await p.shot(S + '/shots/u-01-unread.png')

// ── ② ★别的设备说「这条看过了」→ 本机这颗也要灭 ──────────────────────────
// 这条广播是**手动播**的,不是手机自己调 chat:mark-seen 引出来的回声 ——
// 走回声那条路的话,清掉未读的可能是本机的 viewing 变化,证不出接收路径。
mock.stdin.write('seen s-a2\n')
const cleared = await p.waitFor(`!document.body.innerText.includes('未读')`, 10000)
ok('★★收到别的设备的 chat:seen → 未读灭掉(跨设备未读的接收那一半)', cleared)
await p.shot(S + '/shots/u-02-cleared.png')

// ── ③ ★正开着这条会话、它在眼皮底下跑完 → 手机必须吭一声 ────────────────
// 这是手机的**主要姿势**。原来上报只挂在「viewing 变化」上,这条路一次都不上报,
// 于是电脑端那颗圆点亮着、而且永远不会灭(它在等一个不会再来的 viewing 变化)。
await p.clickText('alpha')
await p.waitFor(`document.body.innerText.includes('加 Windows 打包脚本')`, 10000)
await p.clickText('加 Windows 打包脚本')
await p.waitFor(`!!document.querySelector('textarea[placeholder*="给代理下达任务"]')`, 15000)
// 打开这条会话本身就会上报一次(viewing 变了)。等它落完档再取基线,
// 否则下面量到的「多了一行」可能是开会话那一次,而不是跑完那一次。
await new Promise((r) => setTimeout(r, 1500))
const before = seenLog()
mock.stdin.write('finish s-a2\n')
const reported = await (async () => {
  for (let i = 0; i < 40; i++) {
    if (seenLog().length > before.length) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
})()
ok(
  '★★开着对话页看它跑完 → 也报了一次「看过了」(否则另一台设备的圆点永远不灭)',
  reported && seenLog().slice(before.length).includes('s-a2'),
  JSON.stringify(seenLog().slice(before.length).trim()),
)

await p.close()
chrome.kill()
mock.kill()
