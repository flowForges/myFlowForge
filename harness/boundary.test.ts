import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const REPO = resolve(__dirname, '..')
const HARNESS_SRC = join(REPO, 'harness', 'src')
const APP_SRC = join(REPO, 'src')
const PLUGINS = join(HARNESS_SRC, 'plugins')

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/** 取出文件里所有 import/export-from/动态 import/require 的说明符。 */
function specifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  const out: string[] = []
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1])
  return out
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + sep)
const resolved = (file: string, spec: string) => resolve(dirname(file), spec)

describe('harness 边界', () => {
  it('harness 不 import src/**', () => {
    const bad: string[] = []
    for (const f of walk(HARNESS_SRC))
      for (const s of specifiers(f)) {
        if (s.startsWith('@shared')) bad.push(`${relative(REPO, f)} -> ${s}`)
        else if (s.startsWith('.') && inside(resolved(f, s), APP_SRC)) bad.push(`${relative(REPO, f)} -> ${s}`)
      }
    expect(bad).toEqual([])
  })

  it('app 只经 @mffai/protocol 引用 harness', () => {
    const bad: string[] = []
    for (const f of walk(APP_SRC))
      for (const s of specifiers(f))
        if ((s.includes('harness/') || s.includes('@mffai/')) && s !== '@mffai/protocol') bad.push(`${relative(REPO, f)} -> ${s}`)
    expect(bad).toEqual([])
  })

  it('插件之间不互相 import', () => {
    const bad: string[] = []
    for (const f of walk(PLUGINS)) {
      const parts = relative(PLUGINS, f).split(sep)
      if (parts.length === 1) continue // plugins/index.ts 是静态登记表,允许引用各插件
      const own = parts[0]
      for (const s of specifiers(f)) {
        if (!s.startsWith('.')) continue
        const r = resolved(f, s)
        if (!inside(r, PLUGINS)) continue
        const other = relative(PLUGINS, r).split(sep)[0]
        if (other !== own) bad.push(`${relative(REPO, f)} -> ${s}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('src/main/mffai 不 import electron,index.ts 只动态 import mffai/host', () => {
    const bad: string[] = []
    for (const f of walk(join(APP_SRC, 'main', 'mffai')))
      for (const s of specifiers(f)) if (s === 'electron' || s.startsWith('electron/')) bad.push(`${relative(REPO, f)} -> ${s}`)
    expect(bad).toEqual([])

    const idx = join(APP_SRC, 'main', 'index.ts')
    const text = existsSync(idx) ? readFileSync(idx, 'utf8') : ''
    expect(text).not.toMatch(/^\s*(?:import|export)\b[^;(]*?\bfrom\s*['"]\.\/mffai\/host['"]/m)
    expect(text).not.toMatch(/^\s*import\s*['"]\.\/mffai\/host['"]/m)
  })
})
