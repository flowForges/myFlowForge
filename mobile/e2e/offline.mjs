import fs from 'node:fs'
import { launch, attach } from './cdp.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// 截图和 Chrome 档案落在这里;git 忽略。
const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)

const mock = spawn('node', [path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'mock-daemon.mjs'), '6801', 'gate-confirm'], { stdio: 'ignore' })
await new Promise(r => setTimeout(r, 1200))

const chrome = await launch(S + '/chrome-off')
const p = await attach()
await p.setViewport(390, 844)
await p.goto('http://localhost:8081/add-host')
await new Promise(r => setTimeout(r, 5000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6801')
await p.clickText('保存并连接')
await new Promise(r => setTimeout(r, 4500))
ok('先连上并挂着门', (await p.text()).includes('执行确认'))

// 拔线
mock.kill()
await new Promise(r => setTimeout(r, 3000))
const t = await p.text()
ok('断线显式说出来', /已断开|未连接|连接断开/.test(t), t.split('\n').slice(0, 6).join(' / '))
ok('门还在,但明说答不了', t.includes('未连接 · 答不了'))
// placeholder 不在 innerText 里,得读属性
const ph = await p.eval(`[...document.querySelectorAll('textarea,input')].map(e=>e.placeholder).join(' | ')`)
const editable = await p.eval(`[...document.querySelectorAll('textarea')].map(e=>String(e.disabled||e.readOnly)).join(',')`)
ok('输入框改口说发不出去', /发不出去/.test(ph), ph)
ok('输入框禁用', editable.includes('true'), 'disabled/readOnly=' + editable)
const dis = await p.eval(`(() => {
  const btn=[...document.querySelectorAll('*')].filter(e=>e.textContent.trim()==='允许执行').pop()
  if(!btn) return 'no-btn'
  const s=getComputedStyle(btn.closest('[style*="opacity"]')||btn)
  return s.opacity
})()`)
ok('允许执行按钮已置灰', dis !== '1' && dis !== 'no-btn', 'opacity=' + dis)
ok('断线后已加载的消息还读得到', t.includes('emitNote 只在循环外调了一次'))
await p.shot(S + '/shots/i-01-offline.png')
await p.close(); chrome.kill()
