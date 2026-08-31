/**
 * 只做一件事:把「设置」和「通知」两屏在 390×844 下截出来,好用眼睛看一遍。
 *
 * 跑法:先 `npm run --prefix mobile web`(Metro 要在 :8081),再 `node e2e/shots-settings.mjs`。
 * ★不是断言脚本 —— 这一批改的是「字太多」,而那件事没有任何测试能替人看。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'

const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })

const chrome = await launch(S + '/chrome-shots')
const p = await attach()
await p.setViewport(390, 844)

await p.goto('http://localhost:8081/settings')
await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 180000)
// 存储里可能留着上一趟的主机,和这两屏都无关,清掉省得顶栏状态影响布局。
await p.eval('localStorage.clear()')

// ★深浅两套都要看:浅色下这一屏栽过(见记忆里那几条「浅色白蒙层」),而它是本机唯一能看的地方。
for (const scheme of ['dark', 'light']) {
  await p.setScheme(scheme)
  for (const [route, name] of [['/settings', 'settings'], ['/notifications', 'notifications']]) {
    await p.goto('http://localhost:8081' + route)
    await p.waitFor(`document.body.innerText.length > 0`, 60000)
    await new Promise((r) => setTimeout(r, 800))
    await p.shot(`${S}/shots/${name}-${scheme}.png`)
  }
}

console.log('截图在', S + '/shots')
chrome.kill()
process.exit(0)
