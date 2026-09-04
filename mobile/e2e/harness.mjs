/*
 * 跑 e2e 用的两件小事:**确保假 daemon 真的起来了**,以及**收尾一定跑到**。
 *
 * ★为什么单独抽出来:原来每个脚本都是 `spawn(..., {stdio:'ignore'})` + `sleep 1200`。
 *  只要上一次跑挂在半路(比如某个 clickText 抛了),假 daemon 就不会被 kill,端口一直占着;
 *  下一次跑的新 daemon 撞 EADDRINUSE **直接死掉,而 stderr 是 ignore 的,一个字都看不到**。
 *  于是页面连上的是**上一轮那个残留的 daemon** —— 历史照样显示、断言照样有绿的,
 *  只有「往 stdin 写命令」那一路悄悄失灵,因为写的是新那个已经死了的进程。
 *  排查这个花了二十分钟,而它本可以在第一秒就报出来。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 起一个假 daemon,**等它真的开始监听**再返回。
 * 起不来(端口被占、脚本名不认识、语法错)就抛,绝不返回一个已经死了的进程。
 */
export function startMock(port, script) {
  const child = spawn('node', [path.join(here, 'mock-daemon.mjs'), String(port), script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  return new Promise((res, rej) => {
    let out = ''
    const timer = setTimeout(() => rej(new Error(`假 daemon 在 6 秒内没有开始监听 ${port}。它打印的是:${out || '(什么都没打印)'}`)), 6000)
    child.stdout.on('data', (b) => {
      out += String(b)
      if (out.includes(`ws://127.0.0.1:${port}`)) {
        clearTimeout(timer)
        res(child)
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      rej(new Error(`假 daemon 还没开始监听就退了(code ${code})。多半是端口 ${port} 被上一次没收拾干净的进程占着 —— \`pkill -f mock-daemon.mjs\``))
    })
  })
}

/**
 * 连上假 daemon,一路点到某个会话的对话屏。
 *
 * ★★抽出来的直接原因:这段路**变过三次**,而每个脚本各抄了一份自己的版本 ——
 *  ① 2026-08-29 底部 tab 化之后,「保存并连接」落的是**主机列表**,不再是对话屏;
 *  ② 2026-09-02 主机屏退回根栈的次级屏(第二格给了「工作区」),它盖住 tab bar ⇒ 得先退栈;
 *  ③ 会话列表的工作区分组**默认收起**,不点开就没有会话可点。
 *  抄旧版的脚本不会报「路走错了」,只会在几步之后抛一句「找不到文本 XXX」,
 *  看着像功能坏了 —— `e2e:workflow` 就是这么红了一阵没人发现的。
 * ★顺手清 localStorage:Chrome 档案目录是复用的,上一趟存的主机会带到这一趟来。
 */
export async function openChat(p, port, opts = {}) {
  const { group = 'alpha', session = '修 gate 重复放行' } = opts
  const visible = (text) =>
    `[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(text)}&&e.getBoundingClientRect().width>0)`
  await p.goto('http://localhost:8081/')
  if (!(await p.waitFor(`!!document.querySelector('#root') && document.body.innerText.length > 0`, 120000)))
    throw new Error('页面没起来(Metro 在打包?先 `npm run web`)')
  await p.eval('localStorage.clear()')
  await p.goto('http://localhost:8081/')
  if (!(await p.waitFor(`document.body.innerText.includes('先连一台电脑')`, 60000)))
    throw new Error('没落在首跑引导屏:' + (await p.text()).split('\n').slice(0, 4).join(' / '))
  await p.clickText('添加主机')
  await p.waitFor(`!!document.querySelector('input[placeholder*="192.168"]')`, 15000)
  await p.typeInto('input[placeholder*="192.168"]', `127.0.0.1:${port}`)
  await p.clickText('保存并连接')
  if (!(await p.waitFor(`document.body.innerText.includes('已配对')`, 25000)))
    throw new Error('没连上:' + (await p.text()).split('\n').slice(0, 4).join(' / '))
  // ★★2026-09-02 之后主机屏是**根栈里的次级屏**(底部第二格让给了「工作区」),它盖在 tab bar
  //  上面 —— 所以这里要先退回去,而不是点「会话」那一格(那时候 tab bar 根本没露出来)。
  await p.clickText('‹')
  await p.waitFor(visible(group), 20000)
  await p.clickText(group)          // 分组默认收起
  await p.waitFor(visible(session), 10000)
  await p.clickText(session)
  if (!(await p.waitFor(`!!document.querySelector('[aria-label="更多"]')`, 15000)))
    throw new Error('没进对话屏:' + (await p.text()).split('\n').slice(0, 4).join(' / '))
}

/** 对话屏的 ＋ 面板里点一项(工作流 / 全屏编辑 / 照片…)。 */
export async function plusMenu(p, label) {
  await p.click('[aria-label="更多"]')
  await p.waitFor(`[...document.querySelectorAll('*')].some(e=>e.textContent&&e.textContent.trim()===${JSON.stringify(label)})`, 5000)
  await p.clickText(label)
}
