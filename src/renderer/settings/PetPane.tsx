import { useState, useEffect, type CSSProperties, type ReactElement } from 'react'
import type { Pet, PetState, Anim, Accent } from '@shared/types'
import { ImportModal, type ImportConfig } from '../components/ImportModal'
import { PET_SAMPLE, parsePet, type ParsedPet } from '../components/importParsers'
import { addCustomPet, removeCustomPet, resolveActiveCustomPet, PET_CUSTOM_MAX, type CustomPet } from '@shared/petCustom'
import { growthRowCount } from '@shared/growthPet'
import { clampDailyGoal, GROWTH_GOAL_MIN, GROWTH_GOAL_MAX } from '@shared/growthProgress'
import { gridBackgroundPosition } from '@shared/petAtlas'
import { PetGallery } from './PetGallery'
import { petSrc } from '../pet/petSrc'

let petIdSeq = 0
function genPetId(): string { return `pet-${Date.now()}-${petIdSeq++}-${Math.round(Math.random() * 1e6)}` }

// First available image in a custom pet's pack — used as its gallery thumbnail.
function firstImage(p: CustomPet): string | undefined {
  const imgs = p.images ?? {}
  for (const s of CUSTOM_PREVIEW_STATES) { const v = imgs[s]; if (v) return v }
  return undefined
}

// 成长宠物没有 images/emoji,但它有图 —— 第一阶段的 atlas。直接 <img> 整张贴上去会是一片密密麻麻的
// 小格子(行=动作、列=帧),所以按 GrowthSprite 同一套网格数学只露出 idle 行第 0 帧。
// 返回 undefined = 这不是成长宠物(或包坏了),调用方回落到原来的 emoji/🐾。
function growthThumbStyle(p: CustomPet): CSSProperties | undefined {
  const g = p.growth
  const sheet = g?.stages[0]?.sheet
  if (!g || !sheet) return undefined
  const url = petSrc(sheet)
  if (!url) return undefined
  const rows = growthRowCount(g.actions)
  // idle 缺失时校验器本该拦下,这里仍兜到第 0 行 —— 缩略图不值得为一个坏包整块消失。
  const pos = gridBackgroundPosition(0, g.actions.idle?.row ?? 0, g.atlas.cols, rows)
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: `${g.atlas.cols * 100}% ${rows * 100}%`,
    backgroundPosition: `${pos.x} ${pos.y}`,
    backgroundRepeat: 'no-repeat',
  }
}

interface PetPaneProps {
  pet: Pet
  onChange: (partial: Partial<Pet>) => void
}

const PET_UPLOAD = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
)

const CHECK = (
  <svg className="check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12" />
  </svg>
)

const SKIN_SVG: Record<Pet['skin'], ReactElement> = {
  sprite: (
    <svg viewBox="0 0 64 64" style={{ width: '24px', height: '24px', display: 'block' }}>
      <path d="M32 8c13 0 21 8.5 21 23 0 15-8.5 25-21 25S11 46 11 31C11 16.5 19 8 32 8Z" fill="var(--accent)" />
      <circle cx="24.5" cy="30" r="4" fill="#0b1020" />
      <circle cx="39.5" cy="30" r="4" fill="#0b1020" />
    </svg>
  ),
  bot: (
    <svg viewBox="0 0 64 64" style={{ width: '24px', height: '24px', display: 'block' }}>
      <rect x="12" y="13" width="40" height="38" rx="12" fill="oklch(70% .03 250)" />
      <rect x="19" y="25" width="26" height="14" rx="7" fill="#0b1020" />
      <circle cx="26" cy="32" r="3.2" fill="var(--accent)" />
      <circle cx="38" cy="32" r="3.2" fill="var(--accent)" />
    </svg>
  ),
  ghost: (
    <svg viewBox="0 0 64 64" style={{ width: '24px', height: '24px', display: 'block' }}>
      <path d="M32 9c12 0 19 8 19 21v22c0 2.4-2.7 3.6-4.5 2l-3-2.6c-1-.9-2.6-.9-3.6 0l-3.5 3c-1 .9-2.6.9-3.6 0l-3.6-3c-1-.9-2.6-.9-3.6 0l-3 2.6C19.7 55.6 17 54.4 17 52V30C17 17 20 9 32 9Z" fill="oklch(64% .15 300)" />
      <circle cx="25" cy="29" r="3.6" fill="#fff" />
      <circle cx="39" cy="29" r="3.6" fill="#fff" />
    </svg>
  ),
  // Placeholder for custom skin — full UI in Task 2
  custom: (
    <svg viewBox="0 0 64 64" style={{ width: '24px', height: '24px', display: 'block' }}>
      <path d="M32 8c13 0 21 8.5 21 23 0 15-8.5 25-21 25S11 46 11 31C11 16.5 19 8 32 8Z" fill="var(--accent)" />
      <circle cx="24.5" cy="30" r="4" fill="#0b1020" />
      <circle cx="39.5" cy="30" r="4" fill="#0b1020" />
    </svg>
  )
}

// The 3 built-in SVG skins shown as chips in the unified 形象 gallery (「自定义」is no longer a card — a
// custom pet is represented by its own chip in the same gallery).
const SKIN_CHIPS: { skin: Pet['skin']; label: string }[] = [
  { skin: 'sprite', label: '精灵' },
  { skin: 'bot', label: '机器人' },
  { skin: 'ghost', label: '幽灵' },
]

const CORNERS: { corner: Pet['corner']; label: string }[] = [
  { corner: 'right', label: '右下角' },
  { corner: 'left', label: '左下角' }
]

const PET_STATE_ROWS: { state: PetState; label: string }[] = [
  { state: 'idle', label: '空闲' },
  { state: 'working', label: '执行中' },
  { state: 'confirm', label: '需确认' },
  { state: 'input', label: '需输入' },
  { state: 'done', label: '完成' }
]
const ANIMS: Anim[] = ['float', 'spin-halo', 'alert', 'tilt', 'pulse-ok', 'bounce', 'jelly', 'glow-breathe', 'sparkle', 'flip', 'none']
const ACCENTS: Accent[] = ['none', 'accent', 'warn', 'ok']
const ANIM_LABEL: Record<Anim, string> = { float: '漂浮', 'spin-halo': '光环', alert: '警示', tilt: '倾斜', 'pulse-ok': '脉冲', bounce: '弹跳', jelly: '果冻摇摆', 'glow-breathe': '呼吸发光', sparkle: '星星环绕', flip: '360°转圈', none: '无' }
const ACCENT_LABEL: Record<Accent, string> = { none: '无', accent: '主色', warn: '警告', ok: '完成' }

const NOTIFY: { key: keyof Pet['notify']; t: string; d: string }[] = [
  { key: 'confirm', t: '需要确认时提醒', d: '代理请求执行命令、覆盖文件等需人工确认时弹出提示' },
  { key: 'input', t: '需要输入时提醒', d: '代理等待你补充信息(分支、密钥、参数)时弹出提示' },
  { key: 'done', t: '任务完成时提醒', d: '工作区流程全部跑完时轻量通知' }
]

const CUSTOM_PREVIEW_STATES: PetState[] = ['idle', 'working', 'confirm', 'input', 'done']
const CUSTOM_STATE_LABEL: Record<PetState, string> = {
  idle: '空闲', working: '执行中', confirm: '需确认', input: '需输入', done: '完成'
}

async function handleImportPetPack(pet: Pet, onChange: (partial: Partial<Pet>) => void) {
  const list = pet.customPets ?? []
  if (list.length >= PET_CUSTOM_MAX) return
  // The id must exist BEFORE picking so the main process can write the pack's images into this pet's
  // folder and return { state: relPath } (no inline data URLs).
  const id = genPetId()
  let r: { name: string; images: Record<string, string> } | null
  try {
    r = await window.forge.pickPetPack(id)
  } catch (err) {
    console.error('[PetPane] pickPetPack failed', err)
    return
  }
  if (!r || !r.images || !Object.keys(r.images).length) return
  // Name the pet after the folder when it has a usable name; else a generic sequential label.
  const name = r.name?.trim() || `宠物包 ${list.length + 1}`
  const next = addCustomPet(list, { id, name, images: r.images })
  onChange({ skin: 'custom', customPets: next, activeCustomPetId: id })
}

export function PetPane({ pet, onChange }: PetPaneProps) {
  const [importCfg, setImportCfg] = useState<ImportConfig | null>(null)
  // Which state row is currently playing its animation (click a preview thumbnail to enlarge). The
  // preview shows the state's actual image (animated formats play on their own) so you can verify a
  // pet's look here without running the app to that state.
  const [previewState, setPreviewState] = useState<PetState | null>(null)
  // States whose image failed to load — surface a "换一只?" guide instead of a silently broken preview.
  const [brokenPreview, setBrokenPreview] = useState<Set<PetState>>(new Set())
  // Inline rename of a user (non-builtin) pet: which chip is being renamed + its draft name.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')

  const openPetImport = () => setImportCfg({
    mark: 'pet', title: '自定义桌面宠物', goLabel: '应用形象',
    desc: '用一个表情符号(emoji)和主题色定义你自己的宠物形象。复制下面的示例,改成你喜欢的再上传或粘贴。',
    subTitle: '形象定义(JSON)', sample: PET_SAMPLE,
    placeholder: '粘贴形象 JSON,例如 { "name": "豆豆", "emoji": "🐱", "color": "oklch(72% .16 30)" }',
    drop: '也可「上传文件」选择本地 JSON。emoji 会直接用作角落里的宠物形象。',
    parse: (t) => parsePet(t),
    onImport: (items) => {
      let list = pet.customPets ?? []
      let lastId: string | undefined
      let added = 0
      for (const p of items as ParsedPet[]) {
        if (list.length >= PET_CUSTOM_MAX) break
        const id = genPetId(); lastId = id
        list = addCustomPet(list, { id, name: p.name, emoji: p.emoji, color: p.color })
        added++
      }
      if (added) onChange({ skin: 'custom', customPets: list, activeCustomPetId: lastId })
      return added
        ? `已添加 ${added} 个自定义形象(共 ${list.length}/${PET_CUSTOM_MAX})`
        : `已达上限,最多 ${PET_CUSTOM_MAX} 个`
    },
  })

  const [imgErr, setImgErr] = useState<string | null>(null)

  // Shared picker: writes the chosen image to disk under <petId>/<state> and resolves to its stored
  // relative path, or surfaces the main-process rejection reason inline.
  const pickImageFor = async (petId: string, state: PetState): Promise<string | undefined> => {
    setImgErr(null)
    let r: { path?: string; error?: string } | null
    try {
      r = await window.forge.pickPetImage(petId, state)
    } catch (err) {
      console.error('[PetPane] pickPetImage failed', err)
      return undefined
    }
    if (!r) return undefined
    if (r.error) { setImgErr(r.error); return undefined }
    return r.path
  }

  const handleUploadImage = async () => {
    const list = pet.customPets ?? []
    if (list.length >= PET_CUSTOM_MAX) return
    // id first, so the picked image is written into this pet's folder before it's added.
    const id = genPetId()
    const path = await pickImageFor(id, 'idle')
    if (!path) return
    const next = addCustomPet(list, { id, name: `宠物 ${list.length + 1}`, images: { idle: path } })
    onChange({ skin: 'custom', customPets: next, activeCustomPetId: id })
  }

  // Codex v2 pet import: main-process copies the pack + returns a CustomPet (with atlas); we add it to
  // the list exactly like an uploaded image pet. Discovered packs under ~/.codex/pets are listed on mount.
  const [codexErr, setCodexErr] = useState('')
  const [discovered, setDiscovered] = useState<{ id: string; displayName: string; dir: string }[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState(false) // a scan has completed at least once (for the count copy)
  const rescanCodex = () => {
    if (!window.forge?.codexPetList) return
    setScanning(true)
    void window.forge.codexPetList()
      .then(list => { setDiscovered(list); setScanned(true) })
      .catch(() => {})
      .finally(() => setScanning(false))
  }
  useEffect(() => { rescanCodex() }, [])
  // 成长宠物包的报错走自己的一行,别串到 Codex 那一段去。
  const [growthErr, setGrowthErr] = useState('')
  // 每日目标是「编辑中的草稿 + 失焦/回车提交」,不是每敲一键就写一次盘 —— 与本文件的重命名
  // (commitRename)、TermProxyPane 的代理地址同一套手感。逐键提交的话输入 100000 会连写 6 次
  // 设置,中途的 1、10 还会把宠物进度瞬间顶满再跳回来,肉眼可见地抖。
  const [goalDraft, setGoalDraft] = useState(pet.growthDailyGoal?.toString() ?? '')
  useEffect(() => { setGoalDraft(pet.growthDailyGoal?.toString() ?? '') }, [pet.growthDailyGoal])
  // 输入被 clamp 时的说明行。min/max 只是 HTML 属性,程序化赋值和真实浏览器都拦不住,所以真正的
  // 收敛在 commitGoal 里做;而「改了值却不吭声」比不改更糟(用户以为存的是 1,实际是 50000),
  // 所以 clamp 一旦改动了用户输入,就明说改成了什么。
  const [goalNote, setGoalNote] = useState('')
  const commitGoal = () => {
    const t = goalDraft.trim()
    const n = Number(t)
    // 空 / 非数字 / 非正数 / 小数一律回落到「自动」—— 与 schema 的 z.number().int().positive().catch(undefined)
    // 逐条同构,免得设置里存一个之后会被静默丢弃的坏值。不四舍五入:3.5 是敲错了,不是「想要 4」。
    const raw = t && Number.isInteger(n) && n > 0 ? n : undefined
    // ★ 再过一道 clamp:上下限原本只在 computeDailyGoal(自动推算)里生效,手填这条路一路裸奔到
    // 计数器。输入 1 → goal=1 → progress 恒为 1 → 宠物永远停在最后一档,还查不出原因。
    // 计数器那侧也 clamp(那是兜住手改 settings.json 的最后一道),这里 clamp 是为了当场给反馈:
    // 存进设置的就是生效的那个数,输入框、设置、进度条三者一致,不留"看到的 ≠ 生效的"。
    const next = clampDailyGoal(raw)
    if (next !== pet.growthDailyGoal) onChange({ growthDailyGoal: next })
    // 被拒/被收敛的输入不能继续留在框里骗人,归一化回真正保存的值。
    setGoalDraft(next?.toString() ?? '')
    setGoalNote(raw != null && next != null && raw !== next
      ? `目标需在 ${GROWTH_GOAL_MIN.toLocaleString('en-US')} – ${GROWTH_GOAL_MAX.toLocaleString('en-US')} 之间,已按 ${next.toLocaleString('en-US')} 生效。`
      : '')
  }
  // 装包结果 → customPets。Codex 包与成长包共用这一段(两边的 id 都按源文件夹稳定生成),
  // 只有「错误显示在哪一行」不同,所以把 setter 作为参数传进来。
  const addImported = (
    r: { ok: true; pet: CustomPet } | { ok: false; error: string } | null,
    setErr: (s: string) => void = setCodexErr,
  ) => {
    if (!r) return
    if (!r.ok) { setErr(r.error); return }
    setErr('')
    // Codex pet ids are stable per source folder, so re-importing the same folder (or re-clicking the
    // same discovered pet) must SELECT/refresh the existing entry — never append a duplicate. Upsert by
    // id (mirrors PetGallery.install); only a genuinely new pet counts against the cap.
    const list = pet.customPets ?? []
    const already = list.some(p => p.id === r.pet.id)
    // 到上限只挡「新增」。重装一个已装过的包走的是 upsert 分支,不占名额,所以按钮不该预先禁用
    // (点之前根本不知道用户会选哪个文件夹 —— 是新增还是升级只有装完拿到 id 才知道)。
    if (!already && list.length >= PET_CUSTOM_MAX) {
      setErr(`宠物已达上限 ${PET_CUSTOM_MAX} 个,无法再新增「${r.pet.name}」。先删掉一只再装(重装已装过的包属于升级,不受上限限制)。`)
      return
    }
    const next = already ? list.map(p => (p.id === r.pet.id ? r.pet : p)) : addCustomPet(list, r.pet)
    onChange({ skin: 'custom', customPets: next, activeCustomPetId: r.pet.id })
  }

  const customList = pet.customPets ?? []
  const activeId = pet.activeCustomPetId ?? customList[0]?.id
  const handleSwapStateImage = async (state: PetState) => {
    if (!activeId) return
    const path = await pickImageFor(activeId, state)
    if (!path) return
    onChange({
      customPets: customList.map(p =>
        p.id === activeId ? { ...p, images: { ...p.images, [state]: path } } : p
      ),
    })
  }
  const activeCustom = resolveActiveCustomPet(pet)
  const atMax = customList.length >= PET_CUSTOM_MAX
  // Picking a pet chip also switches skin to 'custom' — in the unified gallery a pet and an SVG skin are
  // alternatives, so choosing a pet must take over from any active sprite/bot/ghost skin.
  const selectPet = (id: string) => { setBrokenPreview(new Set()); setPreviewState(null); onChange({ skin: 'custom', activeCustomPetId: id }) }
  const removePet = (id: string) => {
    const next = removeCustomPet(customList, id)
    const active = pet.activeCustomPetId === id ? next[0]?.id : pet.activeCustomPetId
    onChange({ customPets: next, activeCustomPetId: active })
  }
  const startRename = (p: CustomPet) => { setRenamingId(p.id); setRenameVal(p.name) }
  const commitRename = () => {
    if (renamingId) {
      const name = renameVal.trim()
      if (name) onChange({ customPets: customList.map(p => (p.id === renamingId ? { ...p, name } : p)) })
    }
    setRenamingId(null)
  }

  // The bundled built-in (white-catgirl) is seeded into customPets with a `builtin-` id; downloaded packs
  // get `pack-` ids and read as user pets. Split builtins out into a 「默认宠物」group; user/downloaded
  // pets keep the × delete. More pets are downloadable below via <PetGallery>.
  const builtinList = customList.filter(p => p.id.startsWith('builtin-'))
  // Codex-imported pets get a `codex-` id prefix → pull them into their OWN group at the end, so the
  // user's own uploads (`pet-`) and library downloads (`pack-`) stay adjacent instead of having codex
  // pets wedged between them (insertion order used to interleave all three).
  const codexList = customList.filter(p => p.id.startsWith('codex-'))
  // 成长宠物包同理:`growth-` 前缀自成一组,别混进用户自己上传的那一堆里。
  const growthList = customList.filter(p => p.id.startsWith('growth-'))
  const userList = customList.filter(p => !p.id.startsWith('builtin-') && !p.id.startsWith('codex-') && !p.id.startsWith('growth-'))
  const chipStyle = (active: boolean) => ({
    display: 'flex' as const, alignItems: 'center' as const, gap: '8px', padding: '6px 8px', borderRadius: '10px',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'var(--surface-2)',
    cursor: 'pointer' as const,
  })
  // Built-in SVG skin as a gallery chip — selecting it sets pet.skin (not a custom pet), sitting alongside
  // the image pets in one picker.
  const renderSkinChip = ({ skin, label }: { skin: Pet['skin']; label: string }) => {
    const active = pet.skin === skin
    return (
      <div
        key={skin}
        className={`pet-chip${active ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        title={active ? `${label}(当前)` : `点选为当前:${label}`}
        onClick={() => onChange({ skin })}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange({ skin }) } }}
        style={chipStyle(active)}
      >
        <span style={{ width: '24px', height: '24px', display: 'grid', placeItems: 'center', flex: '0 0 24px' }}>{SKIN_SVG[skin]}</span>
        <span style={{ fontSize: '12px', maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      </div>
    )
  }
  const renderChip = (p: CustomPet) => {
    const active = pet.skin === 'custom' && (pet.activeCustomPetId ?? customList[0]?.id) === p.id
    const builtin = p.id.startsWith('builtin-')
    const thumb = firstImage(p)
    const growthThumb = thumb ? undefined : growthThumbStyle(p)
    return (
      <div
        key={p.id}
        className={`pet-chip${active ? ' on' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={active}
        title={active ? `${p.name}(当前)` : `点选为当前:${p.name}`}
        onClick={() => selectPet(p.id)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPet(p.id) } }}
        style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '10px',
          border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
          background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'var(--surface-2)',
          cursor: 'pointer',
        }}
      >
        {thumb
          ? <img src={petSrc(thumb)} alt="" style={{ width: '24px', height: '24px', objectFit: 'contain', borderRadius: '4px' }} />
          : growthThumb
            ? <span
                data-growth-thumb={p.id}
                role="img"
                aria-label={p.name}
                style={{ width: '24px', height: '24px', flex: '0 0 24px', borderRadius: '4px', ...growthThumb }}
              />
            : <span style={{ fontSize: '20px', color: p.color || undefined }} role="img" aria-label={p.name}>{p.emoji || '🐾'}</span>}
        {renamingId === p.id ? (
          <input
            className="pet-chip-rename"
            aria-label={`重命名 ${p.name}`}
            autoFocus
            value={renameVal}
            onClick={e => e.stopPropagation()}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
            }}
            style={{ fontSize: '12px', width: '96px', padding: '2px 6px', borderRadius: '6px', border: '1px solid var(--accent)', background: 'var(--bg)', color: 'var(--fg)', outline: 'none' }}
          />
        ) : (
          <span style={{ fontSize: '12px', maxWidth: '96px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
        )}
        {!builtin && renamingId !== p.id && (
          <button
            className="pet-chip-rename-btn"
            aria-label={`重命名 ${p.name}`}
            title="重命名"
            onClick={e => { e.stopPropagation(); startRename(p) }}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--faint)', cursor: 'pointer', fontSize: '12px', lineHeight: 1 }}
          >✎</button>
        )}
        {!builtin && (
          <button
            className="pet-chip-x"
            aria-label={`删除 ${p.name}`}
            title="删除"
            onClick={e => { e.stopPropagation(); removePet(p.id) }}
            style={{ marginLeft: '2px', border: 'none', background: 'transparent', color: 'var(--faint)', cursor: 'pointer', fontSize: '15px', lineHeight: 1 }}
          >×</button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="set-group">
        <h4>桌面宠物</h4>
        <p className="set-desc">宠物常驻应用一角,守望所有工作区。点击它可查看哪些工作区、哪些代理在执行;当代理需要确认或输入时,它会提醒你。</p>
        <div className="set-row">
          <div className="info">
            <div className="t">启用桌面宠物</div>
            <div className="d">在窗口角落显示宠物</div>
          </div>
          <button
            className={`toggle${pet.enabled ? ' on' : ''}`}
            aria-label="启用桌面宠物"
            onClick={() => onChange({ enabled: !pet.enabled })}
          />
        </div>
        <div className="set-row" style={{ alignItems: 'flex-start' }}>
          <div className="info">
            <div className="t">交互方式</div>
            <div className="d">「简约」:点击宠物气泡看正在跑的代理 / 确认 / 完成,空闲点击跳到 app(推荐)。「完整」:点击弹出工作区、会话与指令面板。</div>
          </div>
          <div className="seg" data-pet-interaction>
            {([['simple', '简约'], ['full', '完整']] as const).map(([mode, label]) => (
              <button
                key={mode}
                className={`wf-pick${(pet.interactionMode ?? 'simple') === mode ? ' on' : ''}`}
                data-interaction={mode}
                onClick={() => onChange({ interactionMode: mode })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 形象 = 宠物:一个统一的选择器。内置简约形象(精灵/机器人/幽灵)、5 只默认宠物、以及用户自定义
          都在同一画廊里,点选任意一个即为当前形象——不再把「形象」与「宠物」拆成两处。 */}
      <div className="set-group pet-group-tight">
        <h4>形象</h4>
        <p className="set-desc">桌面宠物的形象。内置简约形象与默认宠物都在这里,点选任意一个即为当前显示;也可上传自定义,或在下方「宠物库」下载更多。</p>
        <div className="pet-custom-gallery" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
          {SKIN_CHIPS.map(renderSkinChip)}
          {builtinList.map(renderChip)}
          {userList.map(renderChip)}
          {codexList.length > 0 && (
            <div style={{ flexBasis: '100%', fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>Codex 宠物</div>
          )}
          {codexList.map(renderChip)}
          {growthList.length > 0 && (
            <div style={{ flexBasis: '100%', fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>成长宠物</div>
          )}
          {growthList.map(renderChip)}
        </div>

        <div className="set-row" style={{ marginBottom: '4px' }}>
          <div className="info">
            <div className="t">添加自定义形象 · {userList.length}</div>
            <div className="d">上传后会出现在上面的形象列表里,× 删除。最多 {PET_CUSTOM_MAX} 个(含默认)。</div>
          </div>
        </div>
        <div className="set-row" style={{ marginBottom: '10px', gap: '8px' }}>
            <button
              className="wf-pick on"
              disabled={atMax}
              title={atMax ? `已达上限 ${PET_CUSTOM_MAX} 个` : undefined}
              onClick={() => handleImportPetPack(pet, onChange)}
            >
              添加宠物包
            </button>
            <button
              className="wf-pick on"
              disabled={atMax}
              title={atMax ? `已达上限 ${PET_CUSTOM_MAX} 个` : '选一张本机图片(png/gif/svg/webp,≤2MB),所有状态共用'}
              onClick={handleUploadImage}
            >
              上传图片
            </button>
            <button className="imp-btn pet-custom-link" disabled={atMax} onClick={openPetImport}>
              {PET_UPLOAD}添加自定义形象 · 可复制示例
            </button>
          </div>
          {imgErr && (
            <div className="d" style={{ color: 'var(--warn, #e5484d)', marginBottom: '8px' }}>{imgErr}</div>
          )}

          <div className="set-row" style={{ marginBottom: '4px' }}>
            <div className="info">
              <div className="t">从 Codex 导入宠物</div>
              <div className="d">支持 Codex v2 宠物包(含 pet.json + spritesheet.webp 的文件夹)。拖入文件夹、选择文件夹,或从本机 <code>~/.codex/pets</code> 一键启用。</div>
            </div>
          </div>
          <div className="set-row" style={{ marginBottom: '8px', gap: '8px', flexWrap: 'wrap' }}>
            <button className="wf-pick on" disabled={atMax} onClick={async () => addImported(await window.forge.codexPetPick())}>选择文件夹…</button>
            <div
              className="codex-drop"
              onDragOver={e => e.preventDefault()}
              onDrop={async e => {
                e.preventDefault()
                const f = e.dataTransfer.files[0] as (File & { path?: string }) | undefined
                if (f?.path) addImported(await window.forge.codexPetImport(f.path))
              }}
              style={{ flex: 1, minWidth: '160px', padding: '10px 12px', border: '1px dashed var(--border)', borderRadius: '8px', color: 'var(--faint)', fontSize: '12px', textAlign: 'center' }}
            >
              把 Codex 宠物文件夹拖到这里
            </div>
          </div>
          <div className="set-row" style={{ marginBottom: '6px', gap: '8px', alignItems: 'center' }}>
            <div className="d" style={{ flex: 1 }}>
              {scanning
                ? '正在扫描 ~/.codex/pets …'
                : discovered.length > 0
                  ? `已扫描到 ${discovered.length} 个 Codex 宠物,点击即可导入:`
                  : scanned
                    ? '未在 ~/.codex/pets 扫描到 Codex 宠物。'
                    : ''}
            </div>
            <button className="wf-pick" disabled={scanning} onClick={rescanCodex}>{scanning ? '扫描中…' : '重新扫描'}</button>
          </div>
          {discovered.length > 0 && (
            <div className="set-row" style={{ marginBottom: '8px', gap: '6px', flexWrap: 'wrap' }}>
              {discovered.map(d => (
                <button key={d.dir} className="wf-pick" disabled={atMax} title={d.dir} onClick={async () => addImported(await window.forge.codexPetImport(d.dir))}>
                  {d.displayName}
                </button>
              ))}
            </div>
          )}
          {codexErr && (
            <div className="d" style={{ color: 'var(--warn, #e5484d)', marginBottom: '8px' }}>{codexErr}</div>
          )}

          {/* 成长宠物包:一个文件夹 = pet.json + 每阶段一张 atlas。装进来后宠物的形态跟着今日 token 用量长。 */}
          <div className="set-row" style={{ marginBottom: '4px' }}>
            <div className="info">
              <div className="t">安装成长宠物包</div>
              <div className="d">会随今日 token 用量逐阶段长大的宠物包(含 <code>pet.json</code>(<code>kind: "growth"</code>)与每阶段一张 atlas 的文件夹)。重装同一个文件夹 = 升级,不会多出一只。</div>
            </div>
          </div>
          <div className="set-row" style={{ marginBottom: '8px', gap: '8px' }}>
            <button
              className="wf-pick on"
              // 到上限也不禁用:重装同一个文件夹是升级(id 按源文件夹稳定生成),不占新名额,禁用会把
              // 升级路径一起堵死。而点之前无从得知用户要选哪个文件夹,所以只能装完再判 —— 真是新增
              // 且已满时 addImported 会拒掉并在下面那行给出明确提示。
              // Codex 那段也有一个「选择文件夹…」,光看按钮文字两者无法区分(读屏软件尤其如此),
              // 所以这里给一个说明白的可访问名。
              aria-label="安装成长宠物包"
              title={atMax ? `已达上限 ${PET_CUSTOM_MAX} 个,但重装已装过的成长包升级不受限` : undefined}
              // 兜底 catch:主进程那侧已经把装包异常转成 {ok:false} 了,但 IPC 本身也会失败
              // (主进程重启/通道未注册)。没有 catch 的话 async onClick 里的 rejection 无人接手,
              // 红字行不出现 —— 用户看到的是「点了没反应」,这类"无声失败"最难自查。
              onClick={async () => {
                try { addImported(await window.forge.growthPetImport(), setGrowthErr) }
                catch (e) { setGrowthErr(`安装失败:${e instanceof Error ? e.message : String(e)}`) }
              }}
            >
              选择文件夹…
            </button>
          </div>
          <div className="set-row" style={{ marginBottom: '8px' }}>
            <div className="info">
              <div className="t">每日 token 目标</div>
              <div className="d">成长进度 = 今日 token ÷ 这个目标。留空 = 按过去 7 天用量的中位数自动推算。可填范围 {GROWTH_GOAL_MIN.toLocaleString('en-US')} – {GROWTH_GOAL_MAX.toLocaleString('en-US')}。</div>
            </div>
            <input
              className="sel"
              type="number"
              aria-label="每日 token 目标"
              placeholder="留空 = 自动"
              value={goalDraft}
              // min/max 只是给浏览器的微调按钮/原生提示用的,真正的收敛在 commitGoal 里 —— 取值
              // 直接引 shared 的常量,免得三处上下限各写各的。
              min={GROWTH_GOAL_MIN}
              max={GROWTH_GOAL_MAX}
              step={10000}
              onChange={e => setGoalDraft(e.target.value)}
              onBlur={commitGoal}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitGoal() } }}
            />
          </div>
          {goalNote && (
            <div className="d" style={{ color: 'var(--warn, #e5484d)', marginBottom: '8px' }} role="status">{goalNote}</div>
          )}
          {growthErr && (
            <div className="d" style={{ color: 'var(--warn, #e5484d)', marginBottom: '8px' }}>{growthErr}</div>
          )}

          {pet.skin === 'custom' && (activeCustom.emoji || firstImage({ id: '', name: '', images: activeCustom.images })) && (
            <div className="pet-custom-preview">
              <div className="d" style={{ fontSize: '11px', color: 'var(--faint)', padding: '0 0 6px' }}>点击缩略图放大预览该状态形象</div>
              {CUSTOM_PREVIEW_STATES.map(s => {
                const src = activeCustom.images[s] ?? activeCustom.images.idle
                return (
                  <div key={s} className="set-row" style={{ alignItems: 'center', gap: '8px' }}>
                    <div className="info" style={{ flex: '0 0 56px' }}>
                      <div className="t" style={{ fontSize: '11px' }}>{CUSTOM_STATE_LABEL[s]}</div>
                    </div>
                    {src
                      ? brokenPreview.has(s)
                        ? <span style={{ fontSize: '11px', color: 'var(--warn)' }}>图未加载 · 换一只宠物?</span>
                        : (() => {
                          const playing = previewState === s
                          return (
                            <img
                              className={playing ? 'pet-preview-play' : undefined}
                              src={petSrc(src)}
                              alt={s}
                              role="button"
                              tabIndex={0}
                              title={playing ? '点击收起' : '点击放大预览'}
                              onClick={() => setPreviewState(playing ? null : s)}
                              onError={() => setBrokenPreview(prev => new Set(prev).add(s))}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPreviewState(playing ? null : s) } }}
                              style={{
                                width: playing ? '72px' : '28px', height: playing ? '72px' : '28px',
                                objectFit: 'contain', borderRadius: '6px', cursor: 'pointer',
                                background: playing ? 'var(--surface-2)' : undefined,
                                transition: 'width .15s, height .15s',
                              }}
                            />
                          )
                        })()
                      : activeCustom.emoji
                        ? <span style={{ fontSize: '18px', color: activeCustom.emoji.color || undefined }}>{activeCustom.emoji.emoji}</span>
                        : <span style={{ fontSize: '11px', color: 'var(--faint)' }}>未设置</span>
                    }
                    {customList.length > 0 && (
                      <button
                        className="imp-btn"
                        aria-label={`换图 ${CUSTOM_STATE_LABEL[s]}`}
                        title={`为「${CUSTOM_STATE_LABEL[s]}」状态单独选一张图`}
                        style={{ marginLeft: 'auto', fontSize: '11px', padding: '2px 8px' }}
                        onClick={() => handleSwapStateImage(s)}
                      >
                        换图
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

      <PetGallery pet={pet} onChange={onChange} />

      <div className="set-group">
        <h4>逐状态动画</h4>
        <p className="set-desc">为每个状态单独设置动画与强调色(皮肤沿用上面的全局形象)。</p>
        {PET_STATE_ROWS.map(({ state, label }) => (
          <div className="set-row" key={state} style={{ alignItems: 'flex-start' }}>
            <div className="info" style={{ flex: '0 0 64px' }}><div className="t">{label}</div></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: '1 1 auto', minWidth: 0 }}>
              <div className="seg seg-wrap">
                {ANIMS.map(a => (
                  <button key={a} className={`wf-pick${pet.states[state].anim === a ? ' on' : ''}`}
                    data-anim-state={state} data-anim={a}
                    onClick={() => onChange({ states: { ...pet.states, [state]: { ...pet.states[state], anim: a } } })}>
                    {ANIM_LABEL[a]}
                  </button>
                ))}
              </div>
              <div className="seg seg-wrap">
                {ACCENTS.map(ac => (
                  <button key={ac} className={`wf-pick${pet.states[state].accent === ac ? ' on' : ''}`}
                    data-accent-state={state} data-accent={ac}
                    onClick={() => onChange({ states: { ...pet.states, [state]: { ...pet.states[state], accent: ac } } })}>
                    {ACCENT_LABEL[ac]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="set-group">
        <h4>停靠位置</h4>
        <div className="seg" id="petCorner">
          {CORNERS.map(({ corner, label }) => (
            <button
              key={corner}
              className={`wf-pick${pet.corner === corner ? ' on' : ''}`}
              data-corner={corner}
              onClick={() => onChange({ corner, free: undefined })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">跟随焦点屏幕 / 看向光标</div>
            <div className="d">开:多显示器时宠物跳到你聚焦的那块屏幕,并转头看向光标。关:宠物无视光标——省掉每秒约 7 次的光标轮询(更省电)</div>
          </div>
          <button
            className={`toggle${pet.followCursor ? ' on' : ''}`}
            data-pet-follow
            aria-label="跟随焦点屏幕 / 看向光标"
            onClick={() => onChange({ followCursor: !pet.followCursor })}
          />
        </div>
        <div className="set-row">
          <div className="info">
            <div className="t">空闲动画</div>
            <div className="d">开:宠物空闲时持续呼吸/换帧(活泼)。关:空闲时定格不动,停掉每秒约 5.5 次的重绘——最省电的一项</div>
          </div>
          <button
            className={`toggle${pet.idleAnimation ? ' on' : ''}`}
            aria-label="空闲动画"
            onClick={() => onChange({ idleAnimation: !pet.idleAnimation })}
          />
        </div>
      </div>

      <div className="set-group">
        <h4>提醒</h4>
        {NOTIFY.map(({ key, t, d }) => (
          <div className="set-row" key={key}>
            <div className="info">
              <div className="t">{t}</div>
              <div className="d">{d}</div>
            </div>
            <button
              className={`toggle${pet.notify[key] ? ' on' : ''}`}
              data-pet-notify={key}
              aria-label={t}
              onClick={() => onChange({ notify: { ...pet.notify, [key]: !pet.notify[key] } })}
            />
          </div>
        ))}
      </div>
      <ImportModal config={importCfg} onClose={() => setImportCfg(null)} />
    </>
  )
}
