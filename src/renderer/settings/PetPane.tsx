import { useState, type ReactElement } from 'react'
import type { Pet, PetState, Anim, Accent } from '@shared/types'
import { ImportModal, type ImportConfig } from '../components/ImportModal'
import { PET_SAMPLE, parsePet, type ParsedPet } from '../components/importParsers'
import { addCustomPet, removeCustomPet, resolveActiveCustomPet, PET_CUSTOM_MAX, type CustomPet } from '@shared/petCustom'
import { petSrc } from '../pet/petSrc'

let petIdSeq = 0
function genPetId(): string { return `pet-${Date.now()}-${petIdSeq++}-${Math.round(Math.random() * 1e6)}` }

// First available image in a custom pet's pack — used as its gallery thumbnail.
function firstImage(p: CustomPet): string | undefined {
  const imgs = p.images ?? {}
  for (const s of CUSTOM_PREVIEW_STATES) { const v = imgs[s]; if (v) return v }
  return undefined
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

  // The 5 bundled pets are seeded into customPets with `builtin-` ids. Split them out into their own
  // 「默认宠物」group so they read as defaults, not user-added 「自定义」pets. User pets keep the × delete.
  const builtinList = customList.filter(p => p.id.startsWith('builtin-'))
  const userList = customList.filter(p => !p.id.startsWith('builtin-'))
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
        <div className="set-row" style={{ marginTop: '14px' }}>
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
      <div className="set-group">
        <h4>形象</h4>
        <p className="set-desc">桌面宠物的形象。内置简约形象与 5 只默认宠物都在这里,点选任意一个即为当前显示;也可上传自定义。</p>
        <div className="pet-custom-gallery" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
          {SKIN_CHIPS.map(renderSkinChip)}
          {builtinList.map(renderChip)}
          {userList.map(renderChip)}
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
        <div className="set-row" style={{ marginTop: '14px' }}>
          <div className="info">
            <div className="t">跟随焦点屏幕</div>
            <div className="d">多显示器时,点亮(聚焦)哪个屏幕上的窗口,宠物就跳到那个屏幕的相同相对位置,并停在那儿</div>
          </div>
          <button
            className={`toggle${pet.followCursor ? ' on' : ''}`}
            data-pet-follow
            aria-label="跟随焦点屏幕"
            onClick={() => onChange({ followCursor: !pet.followCursor })}
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
