import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const { externalRequires, verifyPackagedDeps, toPackageName } = require('./packagedDeps.cjs')

const withDir = (fn) => {
  const d = mkdtempSync(join(tmpdir(), 'deps-'))
  try { return fn(d) } finally { rmSync(d, { recursive: true, force: true }) }
}

describe('externalRequires —— 从构建产物里认出真正的运行时依赖', () => {
  it('只收外部包，相对路径和 node 内置一律不算', () => {
    withDir((d) => {
      writeFileSync(join(d, 'index.js'), `
        const a = require("node-pty")
        const b = require("./local")
        const c = require("../up/one")
        const d2 = require("node:fs")
        const e = require("fs")
        const f = require("electron")
      `)
      expect([...externalRequires(d)]).toEqual(['node-pty'])
    })
  })

  it('★electron 和裸写的内置模块要排除 —— 它们不在 app/node_modules 里，误报会让构建白挂', () => {
    withDir((d) => {
      writeFileSync(join(d, 'a.js'), 'require("electron");require("path");require("os");require("ws")')
      expect([...externalRequires(d)]).toEqual(['ws'])
    })
  })

  it('子路径还原成包名；作用域包保留两段', () => {
    expect(toPackageName('lodash/fp')).toBe('lodash')
    expect(toPackageName('@modelcontextprotocol/sdk/server/mcp.js')).toBe('@modelcontextprotocol/sdk')
    expect(toPackageName('ws')).toBe('ws')
  })

  it('要往下递归 —— 产物里有 chunks/ 子目录，只扫顶层会漏掉一半', () => {
    // 这不是假设:真产物里 node-pty 只出现在 out/main/chunks/relayHost-*.js 里,
    // 顶层 out/main/*.js 一处都没有。第一次就是这么漏掉的。
    withDir((d) => {
      mkdirSync(join(d, 'chunks'))
      writeFileSync(join(d, 'index.js'), 'require("zod")')
      writeFileSync(join(d, 'chunks', 'c.js'), 'require("node-pty")')
      expect([...externalRequires(d)].sort()).toEqual(['node-pty', 'zod'])
    })
  })
})

describe('verifyPackagedDeps —— 少一个依赖就让构建挂掉', () => {
  const mkApp = (d, requires, installed) => {
    mkdirSync(join(d, 'out'), { recursive: true })
    writeFileSync(join(d, 'out', 'index.js'), requires.map((r) => `require("${r}")`).join(';'))
    for (const p of installed) mkdirSync(join(d, 'node_modules', p), { recursive: true })
  }

  it('都在 → 通过', () => {
    withDir((d) => {
      mkApp(d, ['ws', 'zod'], ['ws', 'zod'])
      expect(() => verifyPackagedDeps(d, () => {})).not.toThrow()
    })
  })

  it('★★少了就抛，并点名是哪个 + 该往哪放', () => {
    withDir((d) => {
      // 典型场景:把 zod 从 dependencies 挪进了 devDependencies —— 开发时一切正常,
      // 因为两种依赖本机都装着;只有用户装上包才会炸。
      mkApp(d, ['ws', 'zod'], ['ws'])
      expect(() => verifyPackagedDeps(d, () => {})).toThrow(/zod/)
      expect(() => verifyPackagedDeps(d, () => {})).toThrow(/dependencies/)
    })
  })
})
