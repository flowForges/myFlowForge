import fs from 'node:fs'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// 截图和 Chrome 档案落在这里;git 忽略。
const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)

const mock = await startMock(6799, 'both')

const chrome = await launch(S + '/chrome-flow')
const p = await attach()
await p.setViewport(390, 844)

/**
 * 「这段文字此刻在屏幕上看得见」。
 * ★别用 `body.innerText.includes(...)` 代替它:收起的工作区分组里那些会话行**根本没渲染**,
 *  但别处(比如底下那句「N 道门挂在 M 个工作区上」)照样可能出现同样的字。
 *  宽度为 0 的元素一并排除,免得把一个折叠动画中途的节点当成「已经露出来了」。
 */
const visible = (text) =>
  `[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)`

// ★每一趟都从「什么都没配过」开始。Chrome 的档案目录是复用的,而手机端的 AsyncStorage 在 web 上
//  就是 localStorage —— 上一趟存下的主机、以及展开过哪些工作区,会一路带到这一趟来,于是
//  「首跑引导屏」「分组默认收起」两条断言会时绿时红,而实现根本没动过。
//  清完必须**重新载一次页**:store 已经拿旧值挂起来了,只清存储不刷新等于什么都没清。
await p.goto('http://localhost:8081/')
// 第一次打包(Metro 冷启动 + web bundle)可能要几十秒,给足时间;等到的是 #root 真的挂上来。
ok('页面起得来(Metro 打完包)', await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 120000))
await p.eval('localStorage.clear()')
await p.goto('http://localhost:8081/')

let t

// ① 冷启动落**会话列表**。
//    一期把根从对话屏换成了列表屏(`717c494`,`app/sessions.tsx` → `app/index.tsx`),
//    这个脚本此前一直没跟着改:它直奔 `/add-host`、保存完就断言对话屏的内容 —— 那是换根**之前**
//    的行为。零主机时列表屏自己就是首跑引导:一个刚装上的人没有会话可点,只会落在这儿。
ok(
  '冷启动落在会话列表的首跑引导屏(不是对话屏)',
  await p.waitFor(`document.body.innerText.includes('先连一台电脑')`, 60000),
  (await p.text()).split('\n').slice(0, 4).join(' / '),
)

// ② 引导屏 → 添加主机 → 填地址 → 保存
await p.clickText('添加主机')
ok('进得了添加主机屏', await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 15000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6799')
await p.clickText('保存并连接')

// ③ ★保存之后落在**主机列表**(二期 Task 1),不再是对话屏。
//    落这儿的好处正是这条断言在看的东西:刚加的那台就在列表里,连没连上当场看得见。
const onHosts = await p.waitFor(`document.body.innerText.includes('已配对')`, 25000)
t = await p.text()
ok('保存之后落在主机列表', onHosts && !t.includes('保存并连接'), t.split('\n').slice(0, 3).join(' / '))
ok(
  '刚加的那台在列表里,而且真连上了',
  // 「N 个方法」那一段只有 `state.status === 'ready'` 才渲染 —— 它是「真连上了」最硬的证据。
  // 右边那颗胶囊:门挂着时是「N 个门」,没门时才是「已连接」,两种都算连上。
  t.includes('127.0.0.1:6799') && /\d+ 个方法/.test(t) && (t.includes('已连接') || /\d+ 个门/.test(t)),
  t.split('\n').filter((l) => l.includes('方法') || l.includes('个门') || l.includes('已连接')).join(' / '),
)
await p.shot(S + '/shots/h-00-hosts-after-save.png')

// ④ ★返回栈里没有那张空白的添加页。
//    这条钉的是真机验收当场报的那个 bug:扫码那条路会在栈里留下**两个** `/add-host`
//    (「扫一扫」是 `push('/scan')`,`Scanner` 解完码是 `replace('/add-host', 参数)` —— replace
//    换掉的是 `/scan` 那一层)。当时保存完走的是 `goBack()`,只弹掉带参那个,人落回下面那张
//    **空的添加页**;现在走 `nav.ts` 的 `goToHosts()`(`dismissTo('/hosts')`)。
//    ★web 上扫不了码(没有 BarcodeDetector,「扫一扫」那颗按钮根本不摆),所以这里复现不出那个
//    双份栈;能钉住的是它的**后果**:从主机列表往回退,落到的必须是会话列表,绝不能是任何一张
//    添加页。这件事**没有任何单元测试看得见** —— 它整个活在导航栈里。
await p.clickText('‹')
// ★等到列表**真的画出来**(看得见 alpha 这个分组头)再取正文。固定 sleep 在这里有两重害处:
//  ① 机器一忙就间歇性变红;② 下面那条「分组默认是收起的」会在列表还没画出来时**假绿** ——
//  什么都没渲染,它当然也看不见会话行。
const backToList = await p.waitFor(visible('alpha'), 20000)
t = await p.text()
ok(
  '从主机列表按 ‹ 回到会话列表,没有落进空白的添加页',
  backToList && t.includes('myFlowForge') && !t.includes('保存并连接') && !t.includes('扫电脑上那枚码'),
  t.split('\n').slice(0, 3).join(' / '),
)

// ⑤ 工作区分组(二期 Task 5):默认收起 → 点一下展开 → 再点进挂着门的那条会话。
ok('工作区分组默认是收起的', !(await p.eval(visible('修 gate 重复放行'))))
await p.clickText('alpha')
ok('点分组头就展开了,会话露出来', await p.waitFor(visible('修 gate 重复放行'), 8000))
await p.clickText('修 gate 重复放行')
await p.waitFor(`document.body.innerText.includes('执行确认')`, 15000)

t = await p.text()
ok('进的是有门的那个会话', t.includes('修 gate 重复放行') && t.includes('执行确认'))
ok('门编号跨全部门显示 (门 1 / 2)', /门\s*1\s*\/\s*2/.test(t), t.match(/门[^\n]*/)?.[0] ?? '没有编号')
ok('门上带权限档', t.includes('权限档 自动'))
ok('消息流末尾有「已暂停」', t.includes('已暂停'))

// ⑥ 答第一道门 → 应当消失,第二道(选择题)顶上来
await p.clickText('允许执行')
await new Promise(r => setTimeout(r, 1500))
t = await p.text()
ok('答完 confirm 门就消失', !t.includes('npm run build && npm run test'))
ok('第二道门顶上来', t.includes('代理在问你'), t.split('\n').filter(l=>l.includes('门')||l.includes('问你')).join(' / '))
await p.shot(S + '/shots/h-01-second-gate.png')

// ⑦ 进选择题门
await p.clickText('去回答')
await new Promise(r => setTimeout(r, 1500))
t = await p.text()
ok('选择题屏列出选项', t.includes('双写 + 影子读') && t.includes('停机迁移'))
ok('未选时按钮旁有提示', t.includes('选一个') || t.includes('每道题选一个'), t.split('\n').filter(l=>l.includes('选一个')).join(' / '))
await p.shot(S + '/shots/h-02-ask.png')

// ⑧ 选一个再提交
await p.clickText('停机迁移')
await new Promise(r => setTimeout(r, 400))
await p.shot(S + '/shots/h-03-ask-picked.png')
await p.clickText('提交答案')
await new Promise(r => setTimeout(r, 2000))
t = await p.text()
ok('提交后回到对话且门清空', !t.includes('代理在问你') && !t.includes('去回答'))
await p.shot(S + '/shots/h-04-no-gates.png')

// ⑨ 发消息 —— 这条覆盖的是「void handler 的响应能不能解回来」。
//    `chat:send` 没有返回值,网关发的 res 帧里 value 这个键**根本不存在**;协议那边少写一个
//    `.optional()`,这条响应就被当坏帧丢掉、promise 永远不 settle,于是 setText('') 永远不执行 ——
//    真机上的现象就是「点了发送没反应,输入框里的字还在」,而服务端其实已经收到了。
//    ★别指望「答门」能覆盖这一类:门是乐观摘掉的,promise 挂不挂界面上都看不出来。
await p.typeInto('textarea[placeholder*="给代理下达任务"]', '跑一遍测试')
await new Promise((r) => setTimeout(r, 400))
ok('字打进去了', (await p.eval(`document.querySelector('textarea[placeholder*="给代理下达任务"]').value`)) === '跑一遍测试')
await p.clickText('↑')
await new Promise((r) => setTimeout(r, 2500))
const after = await p.eval(`document.querySelector('textarea[placeholder*="给代理下达任务"]').value`)
ok('发出去之后输入框清空了', after === '', JSON.stringify(after))

/**
 * 回会话列表。★走界面上的 ‹(`goBack()`),不要 `p.goto('/…')`:
 *  ① 换根之后 `/sessions` 这条路由**已经不存在**了(一期删掉了 `app/sessions.tsx`),
 *     这个脚本里原来那两句 goto 就是这么悄悄失效的;
 *  ② goto 是整页重载,连接、store、展开状态全部重来一遍,验的就不再是「从对话屏退回来」这件事。
 * 退回来之后分组该是展开着的(点进会话时 `ensureWs` 把它钉住了),万一没有就再点一下分组头。
 */
async function openSession(ws, title) {
  await p.clickText('‹')
  ok(`从对话屏退回会话列表(${title})`, await p.waitFor(visible(ws), 15000))
  if (!(await p.eval(visible(title)))) await p.clickText(ws)
  ok(`列表上点得到「${title}」`, await p.waitFor(visible(title), 8000))
  await p.clickText(title)
  await p.waitFor(`!!document.querySelector('textarea[placeholder*="给代理下达任务"]')`, 15000)
  await new Promise((r) => setTimeout(r, 1500))
}

// ⑩ 内嵌 HTML 折叠 —— 真机上这一坨把正文推出去四五屏
await openSession('alpha', '加 Windows 打包脚本')
let ht = await p.text()
ok('HTML 折成了一行', ht.includes('手机端不渲染') && /可视化片段 · \d+ 行 HTML/.test(ht), ht.split('\n').filter((l) => l.includes('HTML')).join(' / '))
ok('折起来之后原文不露出来', !ht.includes('border-radius:6px'))
ok('前后的正文都还在', ht.includes('要点如下') && ht.includes('你想让我做什么'))
await p.shot(S + '/shots/h-06-html-folded.png')
await p.clickText('▸ 可视化片段 · 13 行 HTML').catch(async () => { await p.clickText('手机端不渲染') })
await new Promise((r) => setTimeout(r, 800))
ok('点开能看到原文', (await p.text()).includes('border-radius:6px'))

// ⑪ 新建会话
await p.clickText('‹')
await p.waitFor(visible('alpha'), 15000)
await p.clickText('＋')
await new Promise((r) => setTimeout(r, 1200))
let st = await p.text()
ok('＋ 打开了工作区选择', st.includes('新建会话') && st.includes('选一个工作区'), st.split('\n').slice(0, 4).join(' / '))
await p.clickText('alpha')
await new Promise((r) => setTimeout(r, 2500))
st = await p.text()
ok('建完落到新会话上', st.includes('新会话') && st.includes('这个会话还没有消息'), st.split('\n').slice(0, 6).join(' / '))
await p.shot(S + '/shots/h-05-new-session.png')

await p.close(); chrome.kill(); mock.kill()
