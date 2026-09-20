import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch, attach } from './cdp.mjs'
import { startMock } from './harness.mjs'

/**
 * 新建工作区(设计文档 §7.4)三步走。
 *
 * ★这一屏最该在真浏览器里验的**不是**样式,是三件在 node 里看不见的事:
 *  ① 目录浏览器里**文件不出现**、没权限的目录**把原话贴出来**(`fs:browse` 失败是回 error 不是抛);
 *  ② 三步没走完时按钮是灰的,而且**旁边写着为什么**(决策 B-2 / workflow.tsx 的同一条规矩);
 *  ③ 最后真发出去的 `workspace:create` 入参**长什么样** —— 它在浏览器里一点痕迹都不留,
 *     所以假 daemon 把它原样落成 `.out/last-create.json`,这里读文件断言。
 *
 * 跑之前先 `npx expo start --web`(要 8081 端口)。
 */
const here = path.dirname(fileURLToPath(import.meta.url))
const S = path.join(here, '.out')
fs.mkdirSync(S + '/shots', { recursive: true })
let bad = 0
const ok = (l, c, e = '') => {
  if (!c) bad++
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${e ? ' — ' + e : ''}`)
}

/**
 * ★把某段文字滚进视口再点。
 *
 * `cdp.mjs` 的 clickText 是**按坐标派发鼠标事件**的 —— 元素在折叠线以下时它算出来的 y
 * 落在视口外面,点击就打在空气上,而且**不报错**:脚本继续往下跑,后面的断言红得莫名其妙。
 * 这一屏是三段表单,主按钮天然在很下面,所以这里每次点之前先滚。
 */
const scrollTo = async (text) => {
  await p.eval(`(() => {
    const e=[...document.querySelectorAll('*')].filter(x=>x.textContent&&x.textContent.trim()===${JSON.stringify(text)}&&x.getBoundingClientRect().width>0).pop()
    if(!e) return false; e.scrollIntoView({block:'center'}); return true
  })()`)
  await new Promise((r) => setTimeout(r, 500))
}
const tapText = async (text) => {
  await scrollTo(text)
  await p.clickText(text)
}
/** 所有输入框当前的值。★`p.text()` 看不到 input 的 value —— 分支名就在输入框里。 */
const inputValues = async () => JSON.parse(await p.eval(`JSON.stringify([...document.querySelectorAll('input,textarea')].map(i=>i.value))`))

const MODE = process.argv[2] || 'plain'
const mock = await startMock(6811, MODE === 'fail' ? 'create-fails' : 'plain')

const chrome = await launch(S + '/chrome-nw')
const p = await attach()
await p.setViewport(390, 844)
// ★第一次打包(Metro 冷启动 + web bundle)可能要几十秒。别用固定 sleep —— 机器一忙就间歇性变红,
//  于是「红了」不再等于「实现坏了」。
await p.goto('http://localhost:8081/')
ok('页面起得来(Metro 打完包)', await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 180000))
// AsyncStorage 在 web 上就是 localStorage,上一趟存的主机会一路带过来。每趟从零开始。
await p.eval('localStorage.clear()')
await p.goto('http://localhost:8081/add-host')
ok('添加主机屏起来了', await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 60000))
await p.typeInto('input[placeholder*="192.168"]', '127.0.0.1:6811')
await p.clickText('保存并连接')
await new Promise((r) => setTimeout(r, 4000))

await p.goto('http://localhost:8081/new-workspace')
ok('这一屏起得来', await p.waitFor(`document.body.innerText.includes('用哪个工作流')`, 60000), (await p.text()).split('\n').slice(0, 6).join(' / '))
await new Promise((r) => setTimeout(r, 1500))

let t = await p.text()
ok('三步都在屏上', t.includes('放哪儿') && t.includes('哪些项目') && t.includes('用哪个工作流'), t.split('\n').slice(0, 8).join(' / '))
ok('列出了主机上的项目', t.includes('forge') && t.includes('api'))
ok('项目显示别名,好在长清单里认出来', t.includes('后端'))
ok('★没有「不同步」这个选项', t.includes('没有「只在手机上加、不同步过去」这回事') && !t.includes('不同步到主机'))
ok('列出了工作流,并且只显示阶段名', t.includes('标准流') && t.includes('需求评估 → 代码开发'))
ok('★库引用阶段解析到了它现在的定义(不是模板里缓存的旧名字)', t.includes('补文档') && !t.includes('缓存的旧名字'))
ok('明说了阶段在电脑上改', t.includes('阶段、提示词、每阶段的代理都在电脑上改'))
ok('一开始按钮旁边写着缺什么', t.includes('先选一个放它的目录'))
await p.shot(S + '/shots/nw-01-form.png')

// ── 第一步:目录浏览器 ───────────────────────────────────────────────────
await p.clickText('选一个父目录')
await new Promise((r) => setTimeout(r, 1500))
t = await p.text()
ok('打开了服务端目录浏览器,落在家目录', t.includes('选一个父目录') && t.includes('/Users/zghua'), t.split('\n').slice(0, 6).join(' / '))
ok('列出了子目录', t.includes('work') && t.includes('Desktop'))
ok('★文件被丢掉了(工作区不可能建在一个文件里)', !t.includes('notes.md'))
await p.shot(S + '/shots/nw-02-browse.png')

// 没权限的目录:原话必须贴出来,不能装成一个空目录
await p.clickText('根目录')
await new Promise((r) => setTimeout(r, 1200))
await p.clickText('root')
await new Promise((r) => setTimeout(r, 1200))
t = await p.text()
ok('★没权限的目录把服务端原话贴出来了', t.includes('EACCES') && t.includes('permission denied'), t.split('\n').slice(0, 6).join(' / '))
ok('★而且说明了不能选它', t.includes('这个目录读不了,不能放在这儿'))
await p.shot(S + '/shots/nw-03-eacces.png')
// 真去点那颗「就放这儿」:它必须**点不动**。第一版这颗键在读不了的目录上照样是亮的,
// 于是要一路走到 clone 那一步才炸 —— 「点了才报错的亮按钮」正是决策 B-2 要消灭的东西。
await p.clickText('就放这儿')
await new Promise((r) => setTimeout(r, 1000))
ok('★读不了的目录选不了(还留在浏览器里)', (await p.text()).includes('工作区会建在它下面'))

await p.clickText('主目录')
await new Promise((r) => setTimeout(r, 1200))
await p.clickText('work')
await new Promise((r) => setTimeout(r, 1200))
ok('能一层层进去', (await p.text()).includes('/Users/zghua/work'))
await p.clickText('就放这儿')
await new Promise((r) => setTimeout(r, 1200))
t = await p.text()
ok('选完回到表单,父目录写在那儿', t.includes('/Users/zghua/work') && t.includes('哪些项目'))
ok('按钮旁边换成了下一条缺的', t.includes('给这个工作区起个名字'))

// ── 名字校验:每一条都要当场说人话 ────────────────────────────────────────
const nameSel = 'input[placeholder="工作区叫什么"], textarea[placeholder="工作区叫什么"]'
await p.typeInto(nameSel, 'a/b')
await new Promise((r) => setTimeout(r, 600))
t = await p.text()
ok('★带斜杠的名字当场被拦住并说明原因', t.includes('这是一个文件夹名,不是路径'), t.split('\n').filter((l) => l.includes('名字')).join(' / '))
await p.clearField(nameSel)
await p.typeInto(nameSel, '.hidden')
await new Promise((r) => setTimeout(r, 600))
ok('以点开头的名字被拦住', (await p.text()).includes('那会建出一个隐藏文件夹'))
await p.clearField(nameSel)
await p.typeInto(nameSel, '已经有这个了')
await new Promise((r) => setTimeout(r, 600))
ok('同名文件夹提前打招呼', (await p.text()).includes('已经有一个叫'))
await p.clearField(nameSel)
await p.typeInto(nameSel, 'phone-ws')
await new Promise((r) => setTimeout(r, 600))
t = await p.text()
ok('★完整路径摊开给你看,不用猜建到哪儿', t.includes('会建出来的是') && t.includes('/Users/zghua/work/phone-ws'))
ok('按钮旁边现在缺的是项目', t.includes('至少选一个项目'))
await p.shot(S + '/shots/nw-04-path.png')

// ── 第二步:选项目 + 分支 ────────────────────────────────────────────────
// ★按仓库地址点,不按项目名点:项目名那个 <T> 里还嵌着别名(textContent 是 `forge  主仓库`),
// clickText 是**精确匹配**,按 'forge' 找不到 —— 而找不到会抛,不会静默点到别处去。
await tapText('git@github.com:me/forge.git')
await new Promise((r) => setTimeout(r, 900))
t = await p.text()
ok('勾上项目后出现分支输入框', t.includes('分支'))
const vals = await inputValues()
ok('★默认分支跟着工作区名字走(和电脑端同一个函数)', vals.some((v) => /^feat\/phone-ws-\d{6}$/.test(v)), JSON.stringify(vals))
await tapText('git@github.com:me/api.git')
await new Promise((r) => setTimeout(r, 900))
t = await p.text()
// ★别断言「2 / 3」:第二步的**步号**也是「2 / 3」,那条断言一个项目都不勾照样绿。
ok('两个项目都勾上了', t.includes('选了 2 / 3'), t.split('\n').filter((l) => l.includes('选了')).join(' / '))
ok('三步齐了,按钮旁边不再挂着理由', !t.includes('至少选一个项目') && !t.includes('选一个工作流'))
await p.shot(S + '/shots/nw-05-projects.png')

// ── 第三步 + 创建 ───────────────────────────────────────────────────────
await tapText('快速修复')
await new Promise((r) => setTimeout(r, 800))
await tapText('创建工作区')
await new Promise((r) => setTimeout(r, 3500))
t = await p.text()

if (MODE === 'fail') {
  ok('★建失败时把服务端原话贴在屏幕上(不是转完圈就没了)', t.includes('repository') && t.includes('not found'), t.split('\n').slice(0, 10).join(' / '))
  ok('留了一条清残件的路', t.includes('没建完的残件') && t.includes('清掉这个半成品') && t.includes('/Users/zghua/work/phone-ws'))
  // ★破坏性动作不与主动作相邻(§7.2 同一条规矩):量两颗键的真实间距,别靠肉眼看截图。
  const gap = await p.eval(`(() => {
    const find=(t)=>[...document.querySelectorAll('*')].filter(e=>e.textContent&&e.textContent.trim()===t&&e.getBoundingClientRect().width>0).pop()
    const a=find('创建工作区'), b=find('清掉这个半成品')
    if(!a||!b) return -1
    const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect()
    return Math.round(rb.top - ra.bottom)
  })()`)
  ok('★清残件那颗 danger 键离主按钮足够远(>40px)', gap > 40, '实测间距 ' + gap + 'px')
  await p.shot(S + '/shots/nw-06-fail.png')
} else {
  ok('建完退回上一屏', !t.includes('用哪个工作流'), t.split('\n').slice(0, 6).join(' / '))
  const sent = JSON.parse(fs.readFileSync(S + '/last-create.json', 'utf8'))
  ok('★发出去的 path = 父目录 + 名字', sent.path === '/Users/zghua/work/phone-ws', sent.path)
  ok('name 是名字本身,不是整条路径', sent.name === 'phone-ws', sent.name)
  ok('★只发了选中的那一个工作流', sent.workflows.length === 1 && sent.workflows[0].id === 'quick', JSON.stringify(sent.workflows.map((w) => w.id)))
  ok(
    '★模板的 defaultAgent/defaultModel 换成了 provider/model',
    sent.workflows[0].stages[0].provider === 'codex' && sent.workflows[0].stages[0].model === 'gpt-5',
    JSON.stringify(sent.workflows[0].stages[0]),
  )
  const lib = sent.workflows[0].stages.find((s) => s.key === 'lib-doc')
  ok('★★库引用阶段带着它真正的提示词发出去了(不解引用就会静默丢掉)', !!lib && lib.prompt === '把这次改动写进 README', JSON.stringify(lib))
  ok('项目发的是 repoId + 分支', sent.projects.length === 2 && sent.projects.every((x) => x.repoId && x.branch), JSON.stringify(sent.projects))
  ok('★每个项目都带上了编码代理(不是空串)', sent.projects.every((x) => x.provider === 'codex'), JSON.stringify(sent.projects.map((x) => x.provider)))
  ok(
    '★入参就这四个键 —— 没有 plugins / stepPlugins(建区 hook 会弹这一屏答不了的门)',
    JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(['name', 'path', 'projects', 'workflows']),
    Object.keys(sent).join(','),
  )
  await p.shot(S + '/shots/nw-06-created.png')
}

await p.close()
chrome.kill()
mock.kill()
console.log(bad ? `\n${bad} 条没过` : '\n全过')
process.exit(bad ? 1 : 0)
