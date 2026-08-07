import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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

  mkdirSync(destDir, { recursive: true })
  for (const j of jobs) writeFileSync(j.to, readFileSync(j.from))

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
