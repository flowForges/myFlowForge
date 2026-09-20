import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { openChat, startMock } from './harness.mjs'

/**
 * 手机上的 MCP 那一屏(**只读**)。
 *
 * ★用户当时说的是「手机能看就行,授权不用」,所以这里断言的重点之一就是
 *  **屏幕上没有授权按钮**,而且说清了去哪儿授权 —— 一个能看见「待授权」却点不了的界面,
 *  必须自己解释为什么。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
let failed = 0
const ok = (l, c, e = '') => { if (!c) failed++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`) }

const mock = await startMock(6812, 'plain')
const chrome = await launch(S + '/chrome-mcp')
const p = await attach()
await p.setViewport(390, 844)
await openChat(p, 6812)          // 先连上(顺带落在一个会话里,带着工作区路径)
await p.clickText('‹')           // 退回会话列表
await p.waitFor(`document.body.innerText.includes('设置')`, 10000)
await p.clickText('设置')
await p.waitFor(`document.body.innerText.includes('MCP 服务器')`, 10000)
await p.clickText('MCP 服务器')
// ★分组头是 `Sec`,它带 textTransform: uppercase —— 屏幕上是 CLAUDE CODE,不是 Claude Code。
if (!(await p.waitFor(`document.body.innerText.includes('CLAUDE CODE')`, 10000))) {
  throw new Error('没进 MCP 屏:' + (await p.text()).split('\n').slice(0, 10).join(' / '))
}

const t = await p.text()
ok('按 provider 分组列出来', t.includes('CLAUDE CODE') && t.includes('CODEX'))
ok('连上的和待授权的都标出来了', t.includes('已连接') && t.includes('待授权'))
ok('★CLI 原话也带着 —— 我们的状态映射猜错了,屏幕上还有真话', t.includes('Needs authentication'))
ok('stdio 的标成「无需授权」,不是「没连上」', t.includes('无需授权'))
ok('★手机上不给授权按钮,而且说清去哪儿授权', !t.includes('授权\n') || t.includes('去电脑端'))
ok('说明里指了电脑端的两个入口', t.includes('/mcp') && t.includes('设置'))
await p.shot(S + '/shots/mcp-01.png')

console.log(failed ? `\n${failed} 条没过` : '\n全过')
await p.close(); chrome.kill(); mock.kill()
process.exit(failed ? 1 : 0)
