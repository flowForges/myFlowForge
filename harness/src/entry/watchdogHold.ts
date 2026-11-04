const ACK_MS = 2000

/**
 * 向监管要一段不数漏 ping 的时间,确认收到才返回:要长时间同步阻塞(VACUUM)之前用。ms 为 0 = 还回去,不等确认。
 * 没有监管(不是子进程)时什么都不用做。监管不确认就抛错:没拿到时间就阻塞,结果是被 SIGKILL
 */
export function createWatchdogHold(ackMs = ACK_MS): (ms: number) => Promise<void> {
  return async ms => {
    if (!process.send) return
    if (ms <= 0) {
      process.send({ t: 'hold', ms: 0 }, () => { /* 通道已关 */ })
      return
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        clearTimeout(timer)
        process.off('message', onMessage)
        if (err) reject(err)
        else resolve()
      }
      const onMessage = (m: { t?: string }) => {
        if (m?.t === 'hold-ack') finish()
      }
      const timer = setTimeout(() => finish(new Error('supervisor did not grant a hold')), ackMs)
      process.on('message', onMessage)
      process.send!({ t: 'hold', ms }, err => {
        if (err) finish(err)
      })
    })
  }
}
