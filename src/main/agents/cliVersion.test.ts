import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCliVersion, getCliVersion } from './cliVersion'

describe('parseCliVersion', () => {
  it('extracts a plain version', () => {
    expect(parseCliVersion('2.1.186 (Claude Code)')).toBe('2.1.186')
  })
  it('takes the LAST version when a proxy banner is printed first', () => {
    // claude/codex wrappers print a proxy-check banner (with an ip:port) before the real version
    expect(parseCliVersion('proxy 127.0.0.1:7897 ✓\ncodex-cli 0.139.0')).toBe('0.139.0')
  })
  it('handles two-part versions', () => {
    expect(parseCliVersion('cursor 2026.06.15')).toBe('2026.06.15')
  })
  it('returns empty when no version present', () => {
    expect(parseCliVersion('no version info here')).toBe('')
  })
})

describe('getCliVersion', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cliver-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  function fakeBin(stdout: string): string {
    const p = join(dir, 'fakebin.js')
    writeFileSync(p, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)})\n`)
    chmodSync(p, 0o755)
    return p
  }
  it('runs <bin> --version and parses it', async () => {
    expect(await getCliVersion(fakeBin('mytool 1.2.3\n'), process.env)).toBe('1.2.3')
  })
  it('returns empty string for an empty bin', async () => {
    expect(await getCliVersion('', process.env)).toBe('')
  })
  it('fails open when the bin does not exist', async () => {
    expect(await getCliVersion('/nonexistent/tool', process.env)).toBe('')
  })
})
