// 监管测试用的假工作进程,行为由 FAKE_MODE 决定:
// ready | crash-once | crash-always | hang | slow-drain | no-ready | vacuum | vacuum-held | hold-then-block
// vacuum*:FAKE_DB 上真跑 VACUUM,vacuum-held 先经 FAKE_HOLD_MODULE(真的 createWatchdogHold)向监管要时间
// FAKE_MARKER:crash-once 的"已崩过"标记文件;FAKE_LOG:收到的消息按行追加到此文件
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'

const mode = process.env.FAKE_MODE ?? 'ready'
const note = (s) => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, `${process.pid} ${s}\n`)

if (mode === 'crash-always') process.exit(1)
if (mode === 'crash-once' && !existsSync(process.env.FAKE_MARKER)) {
  writeFileSync(process.env.FAKE_MARKER, 'x')
  process.exit(1)
}

process.on('message', (m) => {
  note(m.t)
  if (m.t === 'ping' && mode !== 'hang') process.send({ t: 'pong' })
  if (m.t === 'drain' && mode !== 'slow-drain') process.exit(0)
})
process.on('disconnect', () => process.exit(0))
setInterval(() => {}, 1000)
if (mode !== 'no-ready') process.send({ t: 'ready' })

if (mode.startsWith('vacuum') || mode === 'hold-then-block') {
  const { createWatchdogHold } = await import(process.env.FAKE_HOLD_MODULE)
  const hold = createWatchdogHold()
  // 先等几个 ping:IPC 通了,监管才开始数漏 ping
  await new Promise(r => setTimeout(r, 200))
  if (mode === 'hold-then-block') {
    await hold(60_000) // 监管的上限比这小:到点照样杀
    note('holding')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
  } else {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(process.env.FAKE_DB)
    if (mode === 'vacuum-held') await hold(60_000)
    const t = Date.now()
    db.exec('VACUUM')
    note(`vacuumed ${Date.now() - t}`)
    if (mode === 'vacuum-held') await hold(0)
    db.close()
  }
}
