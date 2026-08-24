/*
 * 无头 Chrome 驱动(直接说 CDP,不引 puppeteer)。
 *
 * 为什么不是 `chrome --headless --screenshot` 一把梭:
 *   ① macOS 上无头窗口的**最小宽度是 500px**,`--window-size=390,844` 量到的仍是 500 ——
 *      而 390 正是要验的那个宽度(iPhone 15 Pro)。CDP 的 setDeviceMetricsOverride 才能真给 390。
 *   ② 要点按钮、要读 computed style、要在真会话里走一遍表单 —— 截图模式做不到。
 *
 * 为什么不引 puppeteer:这个仓库不该为了跑几个界面断言多一个几百 MB 的依赖。
 */
import { createRequire } from 'node:module'
const require_ = createRequire(import.meta.url)
// ws 只在仓库根装着(手机端 bundle 用的是平台自带的 WebSocket),从这里借来跑测试。
const pkg = require_('../../node_modules/ws')
const { WebSocket } = pkg
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9333

export async function launch(profile) {
  const p = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
    '--hide-scrollbars', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', detached: false })
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) break
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100))
  }
  return p
}

export async function attach() {
  const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = tabs.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  let id = 0
  const want = new Map()
  const events = []
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.id != null) { const w = want.get(m.id); want.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result) }
    else events.push(m)
  })
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; want.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable')
  return {
    send, events,
    close: () => ws.close(),
    /** 深浅两套都要验。RN 的 useColorScheme 在 web 上读的就是 prefers-color-scheme。 */
    async setScheme(scheme) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
    },
    async setViewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
    },
    async goto(url) {
      await send('Page.navigate', { url })
      await new Promise(r => setTimeout(r, 400))
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
      return r.result.value
    },
    async shot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      fs.writeFileSync(path, Buffer.from(r.data, 'base64'))
      return path
    },
    async click(sel) {
      const box = await this.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
      if (!box) throw new Error('找不到元素: ' + sel)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await new Promise(r => setTimeout(r, 250))
    },
    /** 按可见文本点。RN-web 没有语义化选择器,按文本找是最稳的。 */
    async clickText(text, tag = '*') {
      const box = await this.eval(`(() => {
        const all=[...document.querySelectorAll(${JSON.stringify(tag)})]
        const hits=all.filter(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)
        const e=hits[hits.length-1]; if(!e) return null
        const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}
      })()`)
      if (!box) throw new Error('找不到文本: ' + text)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await new Promise(r => setTimeout(r, 300))
    },
    async typeInto(sel, text) {
      await this.click(sel)
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch })
      }
      await new Promise(r => setTimeout(r, 150))
    },
    async text() { return this.eval('document.body.innerText') },
  }
}
