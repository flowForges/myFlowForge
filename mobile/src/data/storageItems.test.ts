import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { humanSize, STORAGE_ITEMS } from './storageItems'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 把手机端源码里真正用到的 `mff.` key 全捞出来。★读源码,不读名单 —— 理由同 storageKeys.test.ts。 */
function realKeys(): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      // 测试文件里有故意造的假 key(比如 somethingAddedLater),不算数。
      if (/\.test\.tsx?$/.test(e.name)) continue
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/'(mff\.[A-Za-z0-9._-]+)'/g)) out.add(m[1])
    }
  }
  for (const d of ['src', 'app']) walk(path.join(ROOT, d))
  return out
}

describe('缓存管理列的那几项', () => {
  it('★★每一个真实存在的 key 都在表里 —— 漏一个,那份数据就看不见也删不掉', () => {
    // 而界面上一行不少、看起来一切正常。这正是本仓库最常栽的那种假绿。
    const listed = new Set(STORAGE_ITEMS.map((i) => i.key))
    const missing = [...realKeys()].filter((k) => !listed.has(k)).sort()
    expect(missing, `这些 key 没在 STORAGE_ITEMS 里:${missing.join(', ')}`).toEqual([])
  })

  it('★表里也不许有**不存在**的 key —— 那会摆出一行永远是 0 B、删了什么也没发生的假条目', () => {
    const real = realKeys()
    const ghosts = STORAGE_ITEMS.map((i) => i.key).filter((k) => !real.has(k))
    expect(ghosts, `这些 key 在源码里找不到:${ghosts.join(', ')}`).toEqual([])
  })

  it('key 不重复,文案不为空', () => {
    expect(new Set(STORAGE_ITEMS.map((i) => i.key)).size).toBe(STORAGE_ITEMS.length)
    for (const i of STORAGE_ITEMS) {
      expect(i.label.trim().length, i.key).toBeGreaterThan(0)
      expect(i.effect.trim().length, i.key).toBeGreaterThan(0)
    }
  })

  it('★★代价最大的那一项排在最后 —— 别把最危险的按钮放在拇指最容易够到的地方', () => {
    const idx = STORAGE_ITEMS.findIndex((i) => i.reconnect)
    expect(idx).toBe(STORAGE_ITEMS.length - 1)
  })

  it('humanSize:0 字节也要显示出来,「没占空间」和「不存在」是两回事', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(999)).toBe('999 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
