import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseManifest } from './pluginManifest'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'plugin-test-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeManifest(dir: string, content: unknown) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(content), 'utf-8')
}

function writeEntry(dir: string, name = 'run.sh') {
  writeFileSync(join(dir, name), '#!/bin/sh\necho hello', 'utf-8')
}

describe('parseManifest', () => {
  it('valid manifest with entry file → ok + manifest', () => {
    writeManifest(tmpDir, { id: 'test-plugin', name: 'Test Plugin', type: 'script', entry: 'run.sh' })
    writeEntry(tmpDir, 'run.sh')

    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.manifest.id).toBe('test-plugin')
    expect(result.manifest.name).toBe('Test Plugin')
    expect(result.manifest.type).toBe('script')
    expect(result.manifest.entry).toBe('run.sh')
    expect(result.manifest.refreshSec).toBe(300)
  })

  it('no manifest.json → error', () => {
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('manifest.json')
  })

  it('invalid JSON → error', () => {
    writeFileSync(join(tmpDir, 'manifest.json'), '{ not valid json }', 'utf-8')
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('合法 JSON')
  })

  it('schema error (missing id) → error', () => {
    writeManifest(tmpDir, { name: 'Test', type: 'script', entry: 'run.sh' })
    writeEntry(tmpDir)
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
  })

  it('schema error (missing type) → error', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', entry: 'run.sh' })
    writeEntry(tmpDir)
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
  })

  it('schema error (missing entry) → error', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', type: 'script' })
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
  })

  it('entry file missing → error', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', type: 'script', entry: 'missing.sh' })
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toContain('入口文件不存在')
    expect(result.error).toContain('missing.sh')
  })

  it('entry path traversal (../../etc/passwd) → error', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', type: 'script', entry: '../../etc/passwd' })
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected error')
    expect(result.error).toBe('入口文件不在插件目录内')
  })

  it('refreshSec default 300 when omitted', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', type: 'script', entry: 'run.sh' })
    writeEntry(tmpDir)
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.manifest.refreshSec).toBe(300)
  })

  it('refreshSec < 30 clamped to 30', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', type: 'script', entry: 'run.sh', refreshSec: 5 })
    writeEntry(tmpDir)
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.manifest.refreshSec).toBe(30)
  })

  it('refreshSec >= 30 preserved', () => {
    writeManifest(tmpDir, { id: 'test', name: 'Test', type: 'script', entry: 'run.sh', refreshSec: 60 })
    writeEntry(tmpDir)
    const result = parseManifest(tmpDir)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.manifest.refreshSec).toBe(60)
  })
})
