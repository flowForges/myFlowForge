import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkspaceMemory, writeWorkspaceMemory, readSystemMemory, writeSystemMemory, mergeMemory, workspaceMemoryFile } from './memoryStore'

let ws: string
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'mem-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

describe('memoryStore workspace IO', () => {
  it('reads empty string for a fresh workspace', () => {
    expect(readWorkspaceMemory(ws)).toBe('')
  })
  it('writes to .forge/memory/workspace.md and reads it back', () => {
    writeWorkspaceMemory(ws, '## 架构\n- 单仓多 worktree\n')
    expect(existsSync(workspaceMemoryFile(ws))).toBe(true)
    expect(readWorkspaceMemory(ws)).toBe('## 架构\n- 单仓多 worktree\n')
  })
})

describe('memoryStore system IO', () => {
  it('writes system.md and reads it back', () => {
    const before = readSystemMemory()
    try {
      writeSystemMemory('## 偏好\n- 中文回复\n')
      expect(readSystemMemory()).toBe('## 偏好\n- 中文回复\n')
    } finally {
      writeSystemMemory(before)
    }
  })
})

describe('memoryStore.mergeMemory (dedup-by-heading)', () => {
  it('appends a new heading section verbatim', () => {
    const merged = mergeMemory('## 架构\n- a\n', '## 约定\n- 用 vitest\n')
    expect(merged).toContain('## 架构')
    expect(merged).toContain('## 约定')
    expect(merged).toContain('- 用 vitest')
  })
  it('replaces an existing heading section with the incoming one (update, not append)', () => {
    const existing = '## 架构\n- old fact\n\n## 约定\n- 用 vitest\n'
    const incoming = '## 架构\n- new fact\n- extra\n'
    const merged = mergeMemory(existing, incoming)
    expect(merged).toContain('- new fact')
    expect(merged).toContain('- extra')
    expect(merged).not.toContain('- old fact')
    expect(merged).toContain('## 约定')
  })
  it('keeps existing when incoming is blank, and vice versa', () => {
    expect(mergeMemory('## 架构\n- a\n', '')).toBe('## 架构\n- a\n')
    expect(mergeMemory('', '## 架构\n- a\n')).toContain('## 架构')
  })
  it('preserves heading order: existing first, then brand-new headings', () => {
    const merged = mergeMemory('## A\n- 1\n\n## B\n- 2\n', '## B\n- 2b\n\n## C\n- 3\n')
    const order = [...merged.matchAll(/^## (\w)/gm)].map(m => m[1])
    expect(order).toEqual(['A', 'B', 'C'])
  })
})
