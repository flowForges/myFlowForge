import { describe, it, expect, vi } from 'vitest'
import { makeCwdProbe } from './cwdProbe'

describe('makeCwdProbe', () => {
  it('runs lsof for the pid and reports the parsed, home-abbreviated cwd only on change', async () => {
    const exec = vi.fn(async () => 'p1\nfcwd\nn/Users/me/proj\n')
    const seen: string[] = []
    const probe = makeCwdProbe({ exec, home: '/Users/me', onCwd: c => seen.push(c) })
    await probe(1)
    await probe(1)   // same cwd → no duplicate
    expect(exec).toHaveBeenCalledWith(1)
    expect(seen).toEqual(['~/proj'])
  })
})
