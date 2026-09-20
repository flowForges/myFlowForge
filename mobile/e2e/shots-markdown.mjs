/**
 * 把一条**真实回答形状**的 markdown 正文在 390×844 下截出来,深浅两套。
 *
 * 跑法:先 `npm run --prefix mobile web`(Metro 要在 :8081),再 `node e2e/shots-markdown.mjs`。
 * ★不是断言脚本 —— 用户报的是「渲染得非常差」,那件事没有任何断言能替人看。
 *  内容在 `mock-daemon.mjs` 的 `SCRIPT === 'md'` 那一段,照着他发的截图写的。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

const S = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.out')
fs.mkdirSync(S + '/shots', { recursive: true })

const mock = await startMock(6802, 'md')
const chrome = await launch(S + '/chrome-shots-md')
const p = await attach()
await p.setViewport(390, 844)

const step = async (label, fn) => {
  process.stdout.write(`… ${label}\n`)
  const okv = await fn()
  if (okv === false) {
    console.log('!! 卡在这一步。此刻屏幕上是:\n' + (await p.eval('document.body.innerText')).slice(0, 800))
    chrome.kill(); mock.kill?.(); process.exit(1)
  }
}

await step('打开首页', async () => { await p.goto('http://localhost:8081/') ; return p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 180000) })
await p.eval('localStorage.clear()')
await step('填主机', async () => { await p.goto('http://localhost:8081/add-host?a=127.0.0.1%3A6802&t=tok&n=mock'); return p.waitFor(`document.body.innerText.includes('保存并连接')`, 30000) })
// ★保存完落的是**主机屏**(`goToHosts()`),不是会话列表 —— 要自己切回去。
await step('保存并连接', async () => { await p.clickText('保存并连接'); return p.waitFor(`document.body.innerText.includes('已连接')`, 30000) })
await step('回会话列表', async () => { await p.goto('http://localhost:8081/'); return p.waitFor(`document.body.innerText.includes('alpha')`, 30000) })
// ★工作区分组默认是**收起**的,会话行根本没渲染 —— 先展开,不然按标题点是找不到的。
await step('展开 alpha', async () => { await p.clickText('alpha'); return p.waitFor(`document.body.innerText.includes('修 gate 重复放行')`, 20000) })
await step('进对话', async () => { await p.clickText('修 gate 重复放行'); return p.waitFor(`document.body.innerText.includes('关键代码三处')`, 30000) })

// ★量有序列表的记号列。`st.marker` 是 width:22 + paddingRight:7 ⇒ 可用 15pt,而 `1.` 两个
//  等宽字符在 13px 下要 ~15.6pt —— 放不下就折行,句点掉到第二行,看起来像多了一个小圆点。
//  (2026-09-01 截图上就是这么发现的。样式不许猜,量。)
const marks = await p.eval(`(() => {
  const out = []
  for (const e of document.querySelectorAll('*')) {
    if (e.children.length) continue
    const t = (e.textContent || '').trim()
    if (!/^(\\d+\\.|•)$/.test(t)) continue
    const r = e.getBoundingClientRect()
    out.push({ t, box: +r.width.toFixed(1), h: +r.height.toFixed(1), need: e.scrollWidth })
  }
  return out
})()`)
console.log('记号列实测:', JSON.stringify(marks))

// 对话屏是自动滚到底的,而表格在**上半截** —— 两头都要看。
const scrollTo = async (where) =>
  p.eval(`(() => { const el=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+50).pop(); if(el) el.scrollTop = ${where}; })()`)

for (const scheme of ['dark', 'light']) {
  await p.setScheme(scheme)
  await scrollTo('0')
  await new Promise((r) => setTimeout(r, 600))
  await p.shot(`${S}/shots/md-1-${scheme}.png`)   // 标题 + 表格
  await scrollTo('el.scrollHeight')
  await new Promise((r) => setTimeout(r, 600))
  await p.shot(`${S}/shots/md-2-${scheme}.png`)   // 列表 + 引用 + 分隔线 + 链接
}

console.log(await p.eval('document.body.innerText'))
console.log('截图在', S + '/shots')
chrome.kill()
mock.kill?.()
process.exit(0)
