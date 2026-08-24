import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { launch, attach } from './cdp.mjs'

/**
 * 启动工作流 → 推进 → 进执行尾段(带确认)→ 补充说明 → 退出。
 *
 * 服务端那道 `hasRequirement`(需求和补充说明至少要有一句)在假 daemon 里照抄了一份,
 * 所以「不写需求就不许启动」这条是真验过的,不是只验了前端自己的禁用逻辑。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
const ok = (l, c, e = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)

const mock = spawn('node', [path.join(here, 'mock-daemon.mjs'), '6807', 'plain'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

const chrome = await launch(S + '/chrome-wf')
const p = await attach()
await p.setViewport(390, 844)
await p.goto('http://localhost:8081/add-host')
await new Promise((r) => setTimeout(r, 5000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6807')
await p.clickText('保存并连接')
await new Promise((r) => setTimeout(r, 5000))

let t = await p.text()
ok('对话屏有 / 工作流 入口', t.includes('/ 工作流'))
await p.clickText('/ 工作流')
await new Promise((r) => setTimeout(r, 3000))
t = await p.text()
ok('列出了这台机器上的工作流', t.includes('标准流') && t.includes('快速修复'))
ok('项目默认全选', /2\/2/.test(t), t.split('\n').filter((l) => l.includes('/')).slice(0, 3).join(' / '))
ok('没写需求时按钮旁说明了原因', t.includes('阶段代理会自己猜一个需求'))
await p.shot(S + '/shots/w-01-launch.png')

// 需求为空 → 启动键必须是禁用的(不能让人点下去吃一句服务端报错)
const btnOpacity = await p.eval(`(() => {
  // ★别用 /^启动/ —— 页脚那段说明也是「启动后会停在…」开头,.pop() 会挑中它,
  //  于是量到的是一段正文的 opacity,按钮禁没禁根本没验到。按钮文案是确定的,就按全等找。
  const b=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent.trim()==='启动「标准流」').pop()
  if(!b) return 'no-btn'
  let n=b; for(let i=0;i<4&&n;i++,n=n.parentElement){ const o=getComputedStyle(n).opacity; if(o!=='1') return o }
  return '1'
})()`)
ok('没写需求 → 启动键禁用', btnOpacity !== '1' && btnOpacity !== 'no-btn', 'opacity=' + btnOpacity)

await p.typeInto('textarea[placeholder*="一句话说清楚"]', '给评论接口加分页')
await new Promise((r) => setTimeout(r, 400))
await p.clickText('启动「标准流」')
await new Promise((r) => setTimeout(r, 3000))
t = await p.text()
ok('启动后回到对话并出现状态条', t.includes('标准流') && t.includes('需求评估'))
ok('状态条显示 1/4', /1\/4/.test(t), t.split('\n').filter((l) => l.includes('/4')).join(' / '))
ok('推进按钮点名了下一阶段', t.includes('下一步 · 技术方案设计'))
ok('进了工作流就不再给启动入口', !t.includes('/ 工作流'))
await p.shot(S + '/shots/w-02-ribbon.png')

// 对话阶段之间推进:不该弹确认
await p.clickText('下一步 · 技术方案设计')
await new Promise((r) => setTimeout(r, 2000))
t = await p.text()
ok('推进到 2/4', /2\/4/.test(t) && t.includes('技术方案设计'))
ok('对话阶段推进不弹确认', !t.includes('下一步会开始执行'))

// 下一步是扇出阶段 → 必须先问一句
await p.clickText('下一步 · 代码开发(换 codex)')
await new Promise((r) => setTimeout(r, 1500))
t = await p.text()
ok('进执行前先问一句', t.includes('下一步会开始执行') && t.includes('各起一个代理'))
await p.shot(S + '/shots/w-03-confirm.png')
await p.clickText('再想想')
await new Promise((r) => setTimeout(r, 800))
t = await p.text()
ok('「再想想」不推进', /2\/4/.test(t))

await p.clickText('下一步 · 代码开发(换 codex)')
await new Promise((r) => setTimeout(r, 1200))
await p.clickText('下一步 · 代码开发(换 codex)')   // sheet 里的确认按钮同名
await new Promise((r) => setTimeout(r, 2500))
t = await p.text()
ok('确认后进执行态', t.includes('执行中…') && /3\/4/.test(t))
ok('执行态才给补充说明入口', t.includes('补充说明'))
await p.shot(S + '/shots/w-04-executing.png')

await p.clickText('补充说明')
await new Promise((r) => setTimeout(r, 1200))
await p.typeInto('textarea[placeholder*="别动"]', '别动 migrations/')
await new Promise((r) => setTimeout(r, 300))
await p.clickText('提交')
await new Promise((r) => setTimeout(r, 2000))
const fb = (() => { try { return fs.readFileSync(path.join(S, 'last-feedback.txt'), 'utf8') } catch { return '' } })()
ok('补充说明真的送到了服务端', fb === '别动 migrations/', JSON.stringify(fb))

await p.clickText('✕')
await new Promise((r) => setTimeout(r, 2000))
t = await p.text()
ok('退出后状态条消失、入口回来', !t.includes('执行中…') && t.includes('/ 工作流'))

await p.close()
chrome.kill()
mock.kill()
