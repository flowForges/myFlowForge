import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, lstatSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { importGrowthPetPack, growthPetId } from './growthPetImport'

// Windows 上建符号链接可能要额外权限。建不出来就跳过那条用例,别把整个套件拖红。
const canSymlink = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'gp-symprobe-'))
  try { symlinkSync(probe, join(probe, 'link'), 'dir'); return true } catch { return false }
  finally { rmSync(probe, { recursive: true, force: true }) }
})()

// importGrowthPetPack 的 path.relative 守卫是纯纵深防御:只要 shared 的 isSafeRelPath 还在正常
// 工作,任何越界字符串都在它那里就被拦掉了,函数早退,守卫永远打不到。所以想验它,唯一办法是
// 模拟「shared 那层被改坏/被绕过」—— 放行一个逃得出源目录的 sheet,看深层守卫还拦不拦得住。
// 默认不劫持(bypass 为 null 时走真实实现),只有那一条用例把 bypass 打开。
const H = vi.hoisted(() => ({ bypass: null as null | Record<string, unknown> }))
vi.mock('@shared/growthPet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/growthPet')>()
  return {
    ...actual,
    parseGrowthManifest: (raw: unknown) =>
      H.bypass ? { ok: true, manifest: H.bypass } : actual.parseGrowthManifest(raw),
  }
})

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
  H.bypass = null
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

  // 注意这条验的是 shared 那一层。`sub/../../escape.png` 里有 `..` 段,isSafeRelPath 直接就拦了,
  // 装包函数在 `if (!parsed.ok) return parsed` 就早退 —— 根本走不到深层的 path.relative 守卫。
  // 深层守卫由下面那条单独覆盖(它得把 shared mock 掉才打得到)。
  it('shared 层拦截越界路径', () => {
    mkdirSync(join(src, 'sub'), { recursive: true })
    writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest({
      stages: [{ at: 0, sheet: 'sub/../../escape.png' }],
    })))
    const r = importGrowthPetPack(src, dest)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('越出包目录')
  })

  it('shared 放行了也照样拦:深层 path.relative 守卫独立生效', () => {
    // 模拟 shared 的字符串校验被改坏/被绕过,放行一个逃出源目录的 sheet。这是那条守卫存在的
    // 唯一理由 —— 不 mock 就永远打不到它,守卫也就成了摆设(删掉全绿)。
    const outside = join(src, '..', `gp-escape-${process.pid}.png`)
    writeFileSync(outside, 'pwned')
    try {
      H.bypass = {
        id: 'x', name: '越界',
        atlas: { cols: 1, cellW: 1, cellH: 1 },
        actions: { idle: { row: 0, durations: [100] } },
        stages: [{ at: 0, sheet: `../${basename(outside)}` }],
      }
      const r = importGrowthPetPack(src, dest)
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.error).toContain('越出包目录')
      // 而且一个字节都没拷出去 —— 越界的文件绝不能落进宠物图库。
      expect(existsSync(join(dest, growthPetId(src)))).toBe(false)
    } finally {
      rmSync(outside, { force: true })
    }
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

// 重装 = 同一个 id、同一个目录。作者改了文件名或减了阶段,旧图就再也没人引用了,得清掉。
describe('importGrowthPetPack 重装时清理旧阶段图', () => {
  // 把源包换成「改了文件名 / 少了一个阶段」的第二版,阶段图也一并换掉。
  function rewriteAsV2(): void {
    rmSync(join(src, '0-seed.png'))
    rmSync(join(src, '1-trunk.png'))
    writeFileSync(join(src, '0-seed.svg'), '<svg/>')
    writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest({
      stages: [{ at: 0, sheet: '0-seed.svg' }],
    })))
  }

  it('不再被引用的旧图被删掉', () => {
    const id = growthPetId(src)
    expect(importGrowthPetPack(src, dest).ok).toBe(true)
    expect(existsSync(join(dest, id, '0-seed.png'))).toBe(true)
    expect(existsSync(join(dest, id, '1-trunk.png'))).toBe(true)

    rewriteAsV2()
    const r = importGrowthPetPack(src, dest)
    if (!r.ok) throw new Error(r.error)
    expect(r.pet.id).toBe(id) // 同一只宠物,不是新加的
    expect(existsSync(join(dest, id, '0-seed.svg'))).toBe(true)
    expect(existsSync(join(dest, id, '0-seed.png'))).toBe(false)
    expect(existsSync(join(dest, id, '1-trunk.png'))).toBe(false)
  })

  it('本次写入的文件不会被误删(清的只是名单外的)', () => {
    const id = growthPetId(src)
    expect(importGrowthPetPack(src, dest).ok).toBe(true)
    // 名字完全没变的重装:两张图都还得在,内容还得是新的。
    writeFileSync(join(src, '0-seed.png'), 'seedbytes-v2')
    const r = importGrowthPetPack(src, dest)
    if (!r.ok) throw new Error(r.error)
    expect(readFileSync(join(dest, id, '0-seed.png'), 'utf8')).toBe('seedbytes-v2')
    expect(readFileSync(join(dest, id, '1-trunk.png'), 'utf8')).toBe('trunkbytes')
  })

  // ★ 破坏性操作的护栏:清理只准在自己那个 <id>/ 目录里发生。
  it('绝不碰别的宠物的目录,也不碰 pet-images 根下的东西', () => {
    const id = growthPetId(src)
    // 邻居:另一只宠物的目录 + 图库根下的一个文件。
    mkdirSync(join(dest, 'pet-neighbour'), { recursive: true })
    writeFileSync(join(dest, 'pet-neighbour', 'idle.png'), 'neighbour')
    mkdirSync(join(dest, 'growth-other-xyz'), { recursive: true })
    writeFileSync(join(dest, 'growth-other-xyz', '0-seed.png'), 'other-growth')
    writeFileSync(join(dest, 'root-file.png'), 'root')

    expect(importGrowthPetPack(src, dest).ok).toBe(true)
    rewriteAsV2()
    expect(importGrowthPetPack(src, dest).ok).toBe(true)

    // 别人的一个字节都没动 —— 先断言这个:清理跑错目录时,红的必须是这几条,而不是下面那条
    // 「自己清干净了」(否则一条错方向的实现也能因为别的原因变红,分不清是哪个守卫在起作用)。
    expect(readFileSync(join(dest, 'pet-neighbour', 'idle.png'), 'utf8')).toBe('neighbour')
    expect(readFileSync(join(dest, 'growth-other-xyz', '0-seed.png'), 'utf8')).toBe('other-growth')
    expect(readFileSync(join(dest, 'root-file.png'), 'utf8')).toBe('root')
    // 而自己的目录确实清干净了(证明这条用例真的走到了清理,不是因为没清理才"没删到别人")。
    expect(existsSync(join(dest, id, '0-seed.png'))).toBe(false)
  })

  it('装包失败时一个旧文件都不删(校验没过就别动磁盘)', () => {
    const id = growthPetId(src)
    expect(importGrowthPetPack(src, dest).ok).toBe(true)
    // 第二版少了一张图 → 装包在核对阶段就失败。
    rmSync(join(src, '1-trunk.png'))
    expect(importGrowthPetPack(src, dest).ok).toBe(false)
    expect(readFileSync(join(dest, id, '0-seed.png'), 'utf8')).toBe('seedbytes')
    expect(readFileSync(join(dest, id, '1-trunk.png'), 'utf8')).toBe('trunkbytes')
  })

  it('目录里的子目录不会被删(只清这一层的普通文件)', () => {
    const id = growthPetId(src)
    expect(importGrowthPetPack(src, dest).ok).toBe(true)
    mkdirSync(join(dest, id, 'keepme'), { recursive: true })
    writeFileSync(join(dest, id, 'keepme', 'x.png'), 'nested')
    rewriteAsV2()
    expect(importGrowthPetPack(src, dest).ok).toBe(true)
    expect(readFileSync(join(dest, id, 'keepme', 'x.png'), 'utf8')).toBe('nested')
  })

  // ★ 审查实测出来的缺口:path.relative 是纯词法比较、不看 realpath,而 readdir/rm 会跟着软链走。
  // 在 pet-images/ 下放一个名字正好等于目标 id、指向别处的软链,没有 lstat 那道守卫就能把链接
  // 对面的文件删掉 —— 那已经是 pet-images 之外了。
  // 删和写是两条独立的路:mkdirSync(recursive) 对已存在的软链不报错、writeFileSync 照样跟着链接
  // 把图写到对面。所以这条用例两侧都要断言 —— 只查「没少东西」会漏掉「多了东西」。
  it.skipIf(!canSymlink)('pet-images/<id> 自身是符号链接时既不删也不写(两侧都不跟随链接)', () => {
    const id = growthPetId(src)
    const victim = mkdtempSync(join(tmpdir(), 'gp-victim-'))
    try {
      writeFileSync(join(victim, 'precious.txt'), 'precious')
      // dest/<id> 不是真目录,而是一条指向 victim 的软链。
      symlinkSync(victim, join(dest, id), 'dir')

      const r = importGrowthPetPack(src, dest)
      // 拒装,而不是"装成功了(其实写到了链接对面)"。
      expect(r.ok).toBe(false)

      // 链接对面的文件必须原封不动 —— 它压根不在宠物图库里。
      expect(readFileSync(join(victim, 'precious.txt'), 'utf8')).toBe('precious')
      // ★ 写入侧:链接对面不准多出任何东西(旧断言只查了"没少",漏掉了"多了")。
      expect(readdirSync(victim).sort()).toEqual(['precious.txt'])
      // 而且软链本身也没被当成"旧文件"删掉(它在 destAbs 的上一层,本来就不该被扫到)。
      expect(lstatSync(join(dest, id)).isSymbolicLink()).toBe(true)
    } finally {
      rmSync(join(dest, id), { force: true })
      rmSync(victim, { recursive: true, force: true })
    }
  })

  // 同一道守卫的另一半:目标名被一个普通文件占住。没有守卫的话 mkdirSync 会抛 EEXIST 穿出去
  // (对用户就是"点了没反应"),有守卫则给出人话报错。
  it('pet-images/<id> 被同名普通文件占住时给出报错而不是抛异常', () => {
    const id = growthPetId(src)
    writeFileSync(join(dest, id), 'not a dir')
    let r!: ReturnType<typeof importGrowthPetPack>
    expect(() => { r = importGrowthPetPack(src, dest) }).not.toThrow()
    expect(r.ok).toBe(false)
    // 用户放的东西不动它
    expect(readFileSync(join(dest, id), 'utf8')).toBe('not a dir')
  })

  // ★ 顺序:清理必须在写入之后。写到一半 I/O 挂了(这里用「目标文件名被一个同名目录占住」
  // 真实地制造 EISDIR),旧图必须还在 —— 否则会留下「旧的删了、新的没写完、设置仍指向旧路径」
  // 的哑巴宠物。
  it('写入中途失败时不删任何旧图(清理排在写入之后)', () => {
    const id = growthPetId(src)
    expect(importGrowthPetPack(src, dest).ok).toBe(true)

    // 第二版换了两个文件名 → 旧的 0-seed.png / 1-trunk.png 都会落到清理名单里。
    rmSync(join(src, '0-seed.png'))
    rmSync(join(src, '1-trunk.png'))
    writeFileSync(join(src, '0-seed.svg'), '<svg/>')
    writeFileSync(join(src, '1-trunk.svg'), '<svg/>')
    writeFileSync(join(src, 'pet.json'), JSON.stringify(manifest({
      stages: [{ at: 0, sheet: '0-seed.svg' }, { at: 0.5, sheet: '1-trunk.svg' }],
    })))
    // 让第二张图写不进去:目标路径被一个同名目录占着 → writeFileSync 抛 EISDIR。
    mkdirSync(join(dest, id, '1-trunk.svg'), { recursive: true })

    expect(() => importGrowthPetPack(src, dest)).toThrow()

    // 两张旧图一个都没少,宠物还能照常显示。
    expect(readFileSync(join(dest, id, '0-seed.png'), 'utf8')).toBe('seedbytes')
    expect(readFileSync(join(dest, id, '1-trunk.png'), 'utf8')).toBe('trunkbytes')
  })
})
