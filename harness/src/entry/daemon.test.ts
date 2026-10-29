import { describe, expect, it, vi } from 'vitest'
import { gracefulStop } from './daemon'

const mkLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })

describe('gracefulStop', () => {
  it('a failing step is logged and exit(0) is still reached, once', async () => {
    const log = mkLog()
    const exit = vi.fn()
    const stop = gracefulStop(async () => { throw new Error('shutdown exploded') }, log, exit)
    await stop()
    await stop()
    expect(log.error).toHaveBeenCalledWith('shutdown step failed', expect.objectContaining({ error: expect.stringContaining('shutdown exploded') }))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('happy path exits 0 without logging an error', async () => {
    const log = mkLog()
    const exit = vi.fn()
    await gracefulStop(async () => {}, log, exit)()
    expect(exit).toHaveBeenCalledWith(0)
    expect(log.error).not.toHaveBeenCalled()
  })
})
