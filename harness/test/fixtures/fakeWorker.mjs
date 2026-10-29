// 监管测试用的假工作进程,行为由 FAKE_MODE 决定:
// ready | crash-once | crash-always | hang | slow-drain | no-ready
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
