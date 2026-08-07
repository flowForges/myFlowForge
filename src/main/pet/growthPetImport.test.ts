import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importGrowthPetPack, growthPetId } from './growthPetImport'

let src: string
let dest: string

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'growth-tree', name: '成长树', kind: 'growth', signal: 'dailyTokens',
    atlas: { cols: 4, cellW: 100, cellH: 100 },
    actions: { idle: { row: 0, durations: [200, 200] } },
    stages: [{ at: 0, sheet: '0-seed.png' }, { at: 0.5, sheet: '1-trunk.png' }],
    ...over,
  }
}

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), 'gp-src-'))
  dest = mkdtempSync(join(tmpdir(), 'gp-dest-'))
  writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest()))
  writeFileSync(join(src, '0-seed.png'), 'seedbytes')
  writeFileSync(join(src, '1-trunk.png'), 'trunkbytes')
})
afterEach(() => {
  rmSync(src, { recursive: true, force: true })
  rmSync(dest, { recursive: true, force: true })
})

describe('growthPetId', () => {
  it('同一个源文件夹恒得同一个 id(再装一次是升级不是加一只)', () => {
    expect(growthPetId(src)).toBe(growthPetId(src))
  })
  it('不同文件夹得不同 id,即使 manifest id 相同', () => {
    const other = mkdtempSync(join(tmpdir(), 'gp-src2-'))
    expect(growthPetId(src)).not.toBe(growthPetId(other))
    rmSync(other, { recursive: true, force: true })
  })
  it('带 growth- 前缀,便于宠物画廊分组', () => {
    expect(growthPetId(src).startsWith('growth-')).toBe(true)
  })
})

describe('importGrowthPetPack', () => {
  it('拷贝所有阶段图并把 sheet 改写成 forge-pet 相对路径', () => {
    const r = importGrowthPetPack(src, dest)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const id = growthPetId(src)
    expect(r.pet.id).toBe(id)
    expect(r.pet.name).toBe('成长树')
    expect(r.pet.growth?.stages.map((s) => s.sheet)).toEqual([`${id}/0-seed.png`, `${id}/1-trunk.png`])
    expect(existsSync(join(dest, id, '0-seed.png'))).toBe(true)
    expect(existsSync(join(dest, id, '1-trunk.png'))).toBe(true)
  })

  it('保留 atlas 与 actions', () => {
    const r = importGrowthPetPack(src, dest)
    if (!r.ok) throw new Error(r.error)
    expect(r.pet.growth?.atlas).toEqual({ cols: 4, cellW: 100, cellH: 100 })
    expect(r.pet.growth?.actions.idle).toEqual({ row: 0, durations: [200, 200] })
  })

  it('没有 pet.json 时报错', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gp-empty-'))
    const r = importGrowthPetPack(empty, dest)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('pet.json')
    rmSync(empty, { recursive: true, force: true })
  })

  it('阶段图缺失时报错并指名是哪张', () => {
    rmSync(join(src, '1-trunk.png'))
    const r = importGrowthPetPack(src, dest)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('1-trunk.png')
  })

  it('manifest 非法时把校验错误原样带出来', () => {
    writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest({ signal: 'weather' })))
    const r = importGrowthPetPack(src, dest)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('dailyTokens')
  })

  it('拒绝越出包目录的 sheet(纵深防御,shared 校验之外再挡一次)', () => {
    // 绕过 shared 的字符串校验:用一个看着合法、但拼出来会跳出源目录的子路径。
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest({
      stages: [{ at: 0, sheet: 'sub/../../escape.png' }],
    })))
    const r = importGrowthPetPack(src, dest)
    expect(r.ok).toBe(false)
  })

  it('不同子目录下的同名阶段图不会互相覆盖', () => {
    mkdirSync(join(src, 'a'), { recursive: true })
    mkdirSync(join(src, 'b'), { recursive: true })
    writeFileSync(join(src, 'a', 'sheet.png'), 'aaa')
    writeFileSync(join(src, 'b', 'sheet.png'), 'bbb')
    writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest({
      stages: [{ at: 0, sheet: 'a/sheet.png' }, { at: 0.5, sheet: 'b/sheet.png' }],
    })))
    const r = importGrowthPetPack(src, dest)
    if (!r.ok) throw new Error(r.error)
    const sheets = (r.pet.growth?.stages ?? []).map((s) => s.sheet)
    expect(new Set(sheets).size).toBe(2)
    // sheet 已是 "<id>/<name>",直接拼在 dest 下就是拷进去的那张。
    expect(readFileSync(join(dest, sheets[0]!), 'utf8')).toBe('aaa')
    expect(readFileSync(join(dest, sheets[1]!), 'utf8')).toBe('bbb')
  })

  it('任何一张阶段图缺失就一张都不拷(先全部核对再动磁盘,不留残包)', () => {
    rmSync(join(src, '1-trunk.png'))
    const r = importGrowthPetPack(src, dest)
    expect(r.ok).toBe(false)
    expect(existsSync(join(dest, growthPetId(src)))).toBe(false)
  })
})
