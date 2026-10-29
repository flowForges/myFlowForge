import { describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir, ensureToken, runtimePaths } from './index'

describe('paths', () => {
  it('dataDir is under ~/.myFlowForge/mff-ai', () => {
    expect(dataDir('/h')).toBe(join('/h', '.myFlowForge', 'mff-ai'))
  })

  it('short dir uses run/*.sock', () => {
    const p = runtimePaths('/tmp/x', 'linux')
    expect(p.workerAddr).toBe('/tmp/x/run/worker.sock')
    expect(p.controlAddr).toBe('/tmp/x/run/control.sock')
    expect(p.db).toBe('/tmp/x/db/events.sqlite')
  })

  it('120-byte home falls back to tmpdir socket within 103 bytes', () => {
    const dir = dataDir('/' + 'a'.repeat(120))
    const p = runtimePaths(dir, 'darwin')
    for (const [a, name] of [[p.workerAddr, 'worker'], [p.controlAddr, 'control']]) {
      expect(a.startsWith(tmpdir())).toBe(true)
      expect(a).toMatch(new RegExp(`mffai-[0-9a-f]{8}-${name}\\.sock$`))
      expect(Buffer.byteLength(a)).toBeLessThanOrEqual(103)
    }
  })

  it('win32 uses named pipes', () => {
    const p = runtimePaths('C:\\Users\\x\\.myFlowForge\\mff-ai', 'win32')
    expect(p.workerAddr).toMatch(/^\\\\\.\\pipe\\mffai-worker-[0-9a-f]{8}$/)
    expect(p.controlAddr).toMatch(/^\\\\\.\\pipe\\mffai-control-[0-9a-f]{8}$/)
  })

  it.skipIf(process.platform === 'win32')('token is created once with mode 0600', () => {
    const d = mkdtempSync(join(tmpdir(), 'mffai-tok-'))
    try {
      const f = join(d, 'run', 'token')
      const t = ensureToken(f)
      expect(t).toMatch(/^[0-9a-f]{64}$/)
      expect(statSync(f).mode & 0o777).toBe(0o600)
      expect(ensureToken(f)).toBe(t)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it('empty or garbage token file is regenerated atomically', () => {
    const d = mkdtempSync(join(tmpdir(), 'mffai-tok-'))
    try {
      mkdirSync(join(d, 'run'))
      const f = join(d, 'run', 'token')
      writeFileSync(f, '')
      const t = ensureToken(f)
      expect(t).toMatch(/^[0-9a-f]{64}$/)
      expect(ensureToken(f)).toBe(t)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('loose token mode is tightened to 0600', () => {
    const d = mkdtempSync(join(tmpdir(), 'mffai-tok-'))
    try {
      const f = join(d, 'token')
      const t = ensureToken(f)
      chmodSync(f, 0o644)
      expect(ensureToken(f)).toBe(t)
      expect(statSync(f).mode & 0o777).toBe(0o600)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})
