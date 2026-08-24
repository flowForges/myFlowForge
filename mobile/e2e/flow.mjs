import fs from 'node:fs'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// 截图和 Chrome 档案落在这里;git 忽略。
const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)

import { spawn } from 'node:child_process'
const here = path.dirname(fileURLToPath(import.meta.url))
const mock = await startMock(6799, 'both')

const chrome = await launch(S + '/chrome-flow')
const p = await attach()
await p.setViewport(390, 844)
await p.goto('http://localhost:8081/add-host')
await new Promise(r => setTimeout(r, 5000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6799')
await p.clickText('保存并连接')
await new Promise(r => setTimeout(r, 4500))

let t = await p.text()
ok('连上后落在有门的那个会话', t.includes('修 gate 重复放行') && t.includes('执行确认'))
ok('门编号跨全部门显示 (门 1 / 2)', /门\s*1\s*\/\s*2/.test(t), t.match(/门[^\n]*/)?.[0] ?? '没有编号')
ok('门上带权限档', t.includes('权限档 自动'))
ok('消息流末尾有「已暂停」', t.includes('已暂停'))

// ① 答第一道门 → 应当消失,第二道(选择题)顶上来
await p.clickText('允许执行')
await new Promise(r => setTimeout(r, 1500))
t = await p.text()
ok('答完 confirm 门就消失', !t.includes('npm run build && npm run test'))
ok('第二道门顶上来', t.includes('代理在问你'), t.split('\n').filter(l=>l.includes('门')||l.includes('问你')).join(' / '))
await p.shot(S + '/shots/h-01-second-gate.png')

// ② 进选择题门
await p.clickText('去回答')
await new Promise(r => setTimeout(r, 1500))
t = await p.text()
ok('选择题屏列出选项', t.includes('双写 + 影子读') && t.includes('停机迁移'))
ok('未选时按钮旁有提示', t.includes('选一个') || t.includes('每道题选一个'), t.split('\n').filter(l=>l.includes('选一个')).join(' / '))
await p.shot(S + '/shots/h-02-ask.png')

// ③ 选一个再提交
await p.clickText('停机迁移')
await new Promise(r => setTimeout(r, 400))
await p.shot(S + '/shots/h-03-ask-picked.png')
await p.clickText('提交答案')
await new Promise(r => setTimeout(r, 2000))
t = await p.text()
ok('提交后回到对话且门清空', !t.includes('代理在问你') && !t.includes('去回答'))
await p.shot(S + '/shots/h-04-no-gates.png')

// ④ 发消息 —— 这条覆盖的是「void handler 的响应能不能解回来」。
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

// ⑤ 内嵌 HTML 折叠 —— 真机上这一坨把正文推出去四五屏
await p.goto('http://localhost:8081/sessions')
await new Promise((r) => setTimeout(r, 2500))
await p.clickText('加 Windows 打包脚本')
await new Promise((r) => setTimeout(r, 2500))
let ht = await p.text()
ok('HTML 折成了一行', ht.includes('手机端不渲染') && /可视化片段 · \d+ 行 HTML/.test(ht), ht.split('\n').filter((l) => l.includes('HTML')).join(' / '))
ok('折起来之后原文不露出来', !ht.includes('border-radius:6px'))
ok('前后的正文都还在', ht.includes('要点如下') && ht.includes('你想让我做什么'))
await p.shot(S + '/shots/h-06-html-folded.png')
await p.clickText('▸ 可视化片段 · 13 行 HTML').catch(async () => { await p.clickText('手机端不渲染') })
await new Promise((r) => setTimeout(r, 800))
ok('点开能看到原文', (await p.text()).includes('border-radius:6px'))

// ⑥ 新建会话
await p.goto('http://localhost:8081/sessions')
await new Promise((r) => setTimeout(r, 2500))
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
