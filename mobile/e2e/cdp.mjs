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
  // ★先确认 9333 是空的。上一次跑挂在半路(比如 clickText 抛了)时,Chrome 不会自己退 ——
  //  下一次 attach() 会连上**那个残留的浏览器**,于是页面连着的是上一轮已经死掉的假 daemon,
  //  断言开始莫名其妙地红,而实现根本没坏。宁可在这里直接报出来,也不要那种查半天的假红。
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (r.ok) throw new Error(`9333 端口上已经有一个 Chrome 在跑(多半是上次跑挂了没收拾)。先 \`pkill -f remote-debugging-port=${PORT}\` 再来。`)
  } catch (e) {
    if (e instanceof Error && e.message.includes('端口上已经有')) throw e
    // 连不上 = 端口是空的,正是我们要的
  }
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
    /**
     * 按「文本包含若干片段」点**最内层**的那个元素。
     *
     * 为什么需要它:RN-web 里一张工具卡的表头是一个 Pressable,textContent 是所有子 span 拼起来的
     * (`▸编辑src/main/ipc/handlers.ts+3 −1✓`),精确匹配的 clickText 点不中;而只按 `编辑` 点,
     * 页面上有两张「编辑」卡,clickText 取的是最后一个 —— 于是断言在验的根本不是我以为的那张卡。
     */
    async clickContaining(...subs) {
      const box = await this.eval(`(() => {
        const subs=${JSON.stringify(JSON.stringify(subs))}
        const want=JSON.parse(subs)
        const hits=[...document.querySelectorAll('*')].filter(e=>{
          const t=e.textContent||''
          const r=e.getBoundingClientRect()
          return r.width>0 && r.height>0 && want.every(w=>t.includes(w))
        })
        if(!hits.length) return null
        // 最内层 = 面积最小的那个
        const e=hits.sort((a,b)=>{
          const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect()
          return ra.width*ra.height - rb.width*rb.height
        })[0]
        const r=e.getBoundingClientRect()
        return {x:r.x+Math.min(r.width/2,40),y:r.y+r.height/2}
      })()`)
      if (!box) throw new Error('找不到含有这些片段的元素: ' + subs.join(' | '))
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
    /**
     * 轮询等一个条件成立(表达式要返回真值),超时就返回 false。
     *
     * ★别用固定 `sleep`。机器一忙(比如 Metro 正在重打包),固定等待就会**间歇性变红**,
     *  于是「断言红了」不再等于「实现坏了」—— 变异测试也就跟着失去意义。
     */
    async waitFor(expr, timeoutMs = 6000, step = 150) {
      const until = Date.now() + timeoutMs
      for (;;) {
        try { if (await this.eval(expr)) return true } catch { /* 页面正在刷,再试 */ }
        if (Date.now() > until) return false
        await new Promise(r => setTimeout(r, step))
      }
    },
    async text() { return this.eval('document.body.innerText') },
  }
}
