import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { launch, attach } from './cdp.mjs'

/**
 * 两个「看起来对了其实没有」的场景。都是自动化才照得出来的那一类。
 *   ① 答门这一刀没送到 —— 卡片乐观摘掉之后必须自己回来。不回来 = 人以为拦住了,其实门还挂着。
 *   ② 手机是半路加入的 —— 连上时那一轮早就在跑,assistant-start 早播完了。
 *      停止键的初值只能问服务端要,不然代理在跑飞而你按不动。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)

const mock = spawn('node', [path.join(here, 'mock-daemon.mjs'), '6804', 'resolve-fails'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

const chrome = await launch(S + '/chrome-res')
const p = await attach()
await p.setViewport(390, 844)
await p.goto('http://localhost:8081/add-host')
await new Promise((r) => setTimeout(r, 5000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6804')
await p.clickText('保存并连接')
await new Promise((r) => setTimeout(r, 5000))

let t = await p.text()
ok('门在', t.includes('rm -rf build/'))

const stopOpacity = await p.eval(`(() => {
  const b=[...document.querySelectorAll('*')].filter(e=>e.textContent.trim()==='■'&&e.children.length===0).pop()
  if(!b) return 'no-btn'
  let n=b; for(let i=0;i<4&&n;i++,n=n.parentElement){ const o=getComputedStyle(n).opacity; if(o!=='1') return o }
  return '1'
})()`)
ok('半路连上,停止键是亮的', stopOpacity === '1', 'opacity=' + stopOpacity)

await p.clickText('允许执行')
await new Promise((r) => setTimeout(r, 2000))
t = await p.text()
ok('答门失败后卡片自己回来了', t.includes('rm -rf build/'), t.split('\n').filter((l) => l.includes('rm -rf') || l.includes('拒绝了')).join(' / '))
ok('并且说清了为什么', t.includes('拒绝了这次答门'))
await p.shot(S + '/shots/r-01-restored.png')

await p.close()
chrome.kill()
mock.kill()
