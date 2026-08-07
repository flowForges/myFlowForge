import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, rmSync, lstatSync } from 'node:fs'
import { join, basename, resolve, relative, isAbsolute } from 'node:path'
import { parseGrowthManifest } from '@shared/growthPet'
import type { CustomPet } from '@shared/petCustom'
import { petImagesDir } from './petImageStore'

// 与 codexPetImport 同款:只有文件名安全的片段能进磁盘路径。
function safeId(s: string): string { return s.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_') }

function shortHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// 身份 = 源文件夹,不是 manifest 里的 id。理由与 codexPetId 一致:重装同一个文件夹要升级而不是
// 再加一只;两个包撞了 manifest id 也不会互相覆盖存储。growth- 前缀让画廊能分组。
export function growthPetId(srcDir: string): string {
  const abs = resolve(srcDir)
  return `growth-${safeId(basename(abs))}-${shortHash(abs)}`
}

/**
 * 重装同一个文件夹时 id 不变,但作者可能改了文件名(0-seed.png → 0-seed.svg)或减少了阶段数,
 * 旧文件会永远留在 pet-images/<id>/ 里白占盘。新图写完之后把这个目录里不再被引用的旧文件删掉。
 *
 * 顺序刻意放在写入之后:写到一半 I/O 挂了(ENOSPC/EPERM)时,旧图还在原地,设置里指向的
 * 那些 sheet 依然能显示;放在写入之前的话,同样的失败会留下「旧的删了、新的没写完、设置仍指向
 * 旧路径」的哑巴宠物。成功路径两种顺序等价 —— 本次要写的文件名都在 keep 里,写完再删名单外的,
 * 结果一样。
 *
 * 这是破坏性操作,守卫按「宁可不删」写:
 *  - destDir 必须真的在 baseDir 之内且是它的直接子目录(用 path.relative 复查,不看字符串前缀),
 *    否则一步不删;
 *  - destAbs 自身必须是真目录,不能是符号链接 —— path.relative 是纯词法比较、不看 realpath,
 *    而 readdir/rm 会跟着链接走。pet-images/ 下放一个名字正好等于目标 id、指向别处的软链,
 *    没有这道 lstat 就能把链接对面的文件删掉。是链接就早退,不跟随;
 *  - 只删 destDir 这一层的普通文件,不递归、不删目录、也不删目录内部的符号链接条目
 *    (Dirent.isFile() 对 symlink 为 false);装包只写平铺的普通文件,所以任何目录/链接
 *    都不是我们放的,不归我们清;
 *  - keep 是本次写入的文件名集合,命中的一律留着。
 */
function pruneStale(baseDir: string, destDir: string, keep: ReadonlySet<string>): void {
  const baseAbs = resolve(baseDir)
  const destAbs = resolve(destDir)
  const rel = relative(baseAbs, destAbs)
  // rel === '' 意味着 destDir 就是 baseDir 本身(清空整个宠物图库),必须挡掉。
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return
  // 而且只能是 baseDir 的直接子目录 —— 多一层都说明 id 里混进了分隔符,不该发生,发生了就别删。
  if (rel.split(/[\\/]/).length !== 1) return
  // 词法守卫拦不住「destDir 自身是软链」:那种情况下上面几条全过,readdir/rm 却会落到链接对面。
  try { if (!lstatSync(destAbs).isDirectory()) return } catch { return }
  let entries
  try { entries = readdirSync(destAbs, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isFile() || keep.has(e.name)) continue
    try { rmSync(join(destAbs, e.name), { force: true }) } catch { /* best-effort:删不掉只是占点盘 */ }
  }
}

/**
 * 读校验一个成长宠物包目录,把每个阶段的 atlas 拷进 pet-images/<id>/,
 * 返回一个 sheet 已改写成 forge-pet 相对路径的 CustomPet。目录输入,不收 zip。
 */
export function importGrowthPetPack(
  srcDir: string,
  baseDir: string = petImagesDir(),
): { ok: true; pet: CustomPet } | { ok: false; error: string } {
  const manifestPath = join(srcDir, 'pet.json')
  if (!existsSync(manifestPath)) return { ok: false, error: '目录下没有 pet.json' }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { return { ok: false, error: 'pet.json 解析失败' } }
  const parsed = parseGrowthManifest(raw)
  if (!parsed.ok) return parsed
  const m = parsed.manifest

  const id = growthPetId(srcDir)
  const destDir = join(baseDir, id)
  const srcAbs = resolve(srcDir)

  // 先全部核对再动磁盘,避免半拷贝留下一个装不起来的残包。
  const jobs: { from: string; to: string; rel: string }[] = []
  // 拷进去的文件名只取 basename,所以包里 `a/sheet.png` 与 `b/sheet.png` 会撞成同一个目标名 ——
  // 不去重的话后拷的那张会覆盖前一张,两个阶段最后指向同一张图(画面错但不报错,最难查)。
  // 撞名时加序号前缀;循环到唯一为止,免得前缀本身又跟某个真实文件名撞上。
  const used = new Set<string>()
  for (const stage of m.stages) {
    const from = resolve(srcAbs, stage.sheet)
    // 纵深防御:shared 已做过字符串级校验,这里再用 relative 复查一次真实解析结果
    // (与 pluginManifest.ts / pluginHost.ts 同款双重检查)。
    const rel = relative(srcAbs, from)
    if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: `阶段图越出包目录: ${stage.sheet}` }
    if (!existsSync(from)) return { ok: false, error: `找不到阶段图 ${stage.sheet}` }
    const base = safeId(basename(stage.sheet))
    let name = base
    for (let n = 1; used.has(name); n++) name = `${n}-${base}`
    used.add(name)
    jobs.push({ from, to: join(destDir, name), rel: `${id}/${name}` })
  }

  // 写入侧也要挡软链,不能只靠 pruneStale 那道(它管的是删)。mkdirSync(recursive) 对「已经存在的
  // 软链指向目录」不报错,writeFileSync 又会跟着链接走 —— 结果是把图写到 pet-images 之外的地方。
  // pet-images/ 下出现一个名字正好等于目标 id 的软链本来就不是我们放的,一律拒装:不跟随、也不删
  // (删掉等于替用户处理他自己放进来的东西)。顺带把「被普通文件占住」也拦在这里给出人话报错,
  // 否则下面的 mkdirSync 会抛一个 EEXIST/ENOTDIR 出去。
  try {
    const st = lstatSync(destDir)
    if (!st.isDirectory()) {
      const what = st.isSymbolicLink() ? '符号链接' : '同名文件'
      return { ok: false, error: `宠物图库里 ${id} 被一个${what}占用,已取消安装(请先移除它)` }
    }
  } catch { /* 不存在 = 首次安装,正常往下走 */ }
  mkdirSync(destDir, { recursive: true })
  for (const j of jobs) writeFileSync(j.to, readFileSync(j.from))
  // 写完再清。中途 I/O 挂掉时旧图还在,宠物不至于哑掉(详见 pruneStale 的注释)。
  pruneStale(baseDir, destDir, used)

  return {
    ok: true,
    pet: {
      id,
      name: m.name,
      growth: {
        atlas: m.atlas,
        actions: m.actions,
        stages: m.stages.map((s, i) => (s.name ? { at: s.at, name: s.name, sheet: jobs[i].rel } : { at: s.at, sheet: jobs[i].rel })),
      },
    },
  }
}
