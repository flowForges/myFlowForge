import fs from 'node:fs'
import { launch, attach } from './cdp.mjs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// 截图和 Chrome 档案落在这里;git 忽略。
const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (label, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`)

import { spawn } from 'node:child_process'
const here = path.dirname(fileURLToPath(import.meta.url))
const mock = spawn('node', [path.join(here, 'mock-daemon.mjs'), '6799', 'both'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

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

// ④ 断线:杀掉假 daemon,界面必须显式说断线,发送/答门禁用
await p.close(); chrome.kill(); mock.kill()
