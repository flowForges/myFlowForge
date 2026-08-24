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
