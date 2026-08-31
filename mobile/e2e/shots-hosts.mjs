/**
 * 「主机」屏 + 长按呼出的改名单子,截出来用眼睛看一遍。
 *
 * 跑法:先 `npm run --prefix mobile web`(Metro 要在 :8081),再 `node e2e/shots-hosts.mjs`。
 * ★不是断言脚本 —— 改名这块 UI 只有真看一眼才知道单子有没有被键盘顶掉、名字有没有被挤扁。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })

const mock = await startMock(6799, 'both')
const chrome = await launch(S + '/chrome-shots-hosts')
const p = await attach()
await p.setViewport(390, 844)

await p.goto('http://localhost:8081/')
await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 180000)
await p.eval('localStorage.clear()')

// 配一台,好让「主机」屏上真有一行可以长按。
await p.goto('http://localhost:8081/add-host?a=127.0.0.1%3A6799&t=tok&n=' + encodeURIComponent('书房的 Mac'))
await p.waitFor(`document.body.innerText.includes('保存并连接')`, 30000)
await p.clickText('保存并连接')
await new Promise((r) => setTimeout(r, 1500))

await p.goto('http://localhost:8081/hosts')
await p.waitFor(`document.body.innerText.includes('已配对')`, 30000)
await p.shot(`${S}/shots/hosts.png`)

/** 长按 = 按下去、按住 700ms、再松开。RN-web 的 Pressable 默认 500ms 算长按。 */
const longPressText = async (text) => {
  const box = await p.eval(`(() => {
    const hits=[...document.querySelectorAll('*')].filter(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)
    const e=hits[hits.length-1]; if(!e) return null
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}
  })()`)
  if (!box) throw new Error('找不到文本: ' + text)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 700))
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await new Promise((r) => setTimeout(r, 600))
}

await longPressText('书房的 Mac')
console.log(await p.eval('document.body.innerText'))
await p.shot(`${S}/shots/hosts-rename.png`)

console.log('截图在', S + '/shots')
chrome.kill()
await mock.close?.()
process.exit(0)
