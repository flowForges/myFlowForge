import { describe, expect, it } from 'vitest'
import { realExec } from './exec'

const node = process.execPath

describe('realExec', () => {
  it('passes stdin and returns stdout + exit code', async () => {
    const r = await realExec(node, ['-e', 'process.stdin.pipe(process.stdout)'], 'hello-stdin', 5000)
    expect(r).toEqual({ code: 0, stdout: 'hello-stdin', timedOut: false })
  })

  it('kills a hanging command at the timeout', async () => {
    const t0 = Date.now()
    const r = await realExec(node, ['-e', 'setInterval(() => {}, 1000)'], '', 300)
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('missing command → code null, no throw', async () => {
    const r = await realExec('mffai-definitely-not-a-command', [], '', 5000)
    expect(r).toEqual({ code: null, stdout: '', timedOut: false })
  })
})
