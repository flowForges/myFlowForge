import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Pins the 1.3.0-cu.1 fix: shared code lands in out/main/chunks/, so an entry resolved from __dirname is missing.
const SRC = join(__dirname, '..')
const BAD = /\b(?:join|resolve)\(\s*__dirname\s*,\s*['"`](?:forgeMcp|agentShim)\.js['"`]/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
  })
}

describe('no main-process entry resolved from __dirname', () => {
  it('src/main never does join/resolve(__dirname, "forgeMcp.js" | "agentShim.js")', () => {
    const hits = files(SRC).filter((f) => BAD.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f))
    expect(hits).toEqual([])
  })
  it('the pattern catches the old line', () => {
    expect(BAD.test("const mcpEntry = join(__dirname, 'forgeMcp.js')")).toBe(true)
    expect(BAD.test("mainEntryPath(__dirname, 'forgeMcp.js')")).toBe(false)
  })
})
