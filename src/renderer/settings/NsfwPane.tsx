import { useEffect, useState } from 'react'
import type { Pet, Appearance } from '@shared/types'
import type { NsfwCatalog, NsfwPet, NsfwBg } from '@shared/nsfw'
import { NSFW_PREVIEW_COOLDOWN_MS, NSFW_GALLERY_MEMO_MS } from '@shared/nsfw'
import { addCustomPet, PET_CUSTOM_MAX } from '@shared/petCustom'

let seq = 0
const genPetId = () => `pet-${Date.now()}-${seq++}-${Math.round(Math.random() * 1e6)}`

// Module-level memo of the last successful batch gallery — survives pane unmount/remount (switching
// settings panes) so re-opening 扩展内容 within NSFW_GALLERY_MEMO_MS costs ZERO Cloudflare requests.
// Only a forced 刷新 or an expired window re-fetches. (Cleared on process exit — a fresh run pays 1.)
let galleryMemo: { at: number; pets: NsfwPet[]; backgrounds: NsfwBg[]; previews: Record<string, string> } | null = null
// Test-only: clears the cross-mount gallery memo so each test starts cold.
export function __resetNsfwGalleryMemo(): void { galleryMemo = null }

interface NsfwPaneProps {
  pet: Pet
  nsfwInstalled: Record<string, string>          // catalog key → local ref (bg: forge-bg:// URL; pet: customPets id)
  onChangePet: (p: Partial<Pet>) => void
  onChangeAppearance: (p: Partial<Appearance>) => void
  onSetInstalled: (key: string, ref: string) => void
  onDisable: () => void                          // 关闭扩展:重新锁定(隐藏本 pane 入口),需重新兑换才能再开
}

// The gated extra-content pane (reachable only after activation). Two-state per item:
//   安装 — never downloaded → download, store on disk, apply, remember it.
//   设置 — downloaded before → if the local file is still there just apply it; if it was deleted/GC'd,
//          re-download then apply. Nothing is held in memory: images live on disk, served via protocol.
export function NsfwPane({ pet, nsfwInstalled, onChangePet, onChangeAppearance, onSetInstalled, onDisable }: NsfwPaneProps) {
  const [catalog, setCatalog] = useState<NsfwCatalog | null>(galleryMemo ? { pets: galleryMemo.pets, backgrounds: galleryMemo.backgrounds } : null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, string>>(galleryMemo?.previews ?? {}) // key → forge-bg:// URL (on-disk cache)
  // 限流:一次批量刷新后,把「刷新」按钮禁用 NSFW_PREVIEW_COOLDOWN_MS,防止一直点。nowTick 只在冷却期间跑,
  // 用来刷新倒计时显示。
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return
    const t = setInterval(() => setNowTick(Date.now()), 500)
    return () => clearInterval(t)
  }, [cooldownUntil])
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - nowTick) / 1000))

  // 加载(设计 E):先要一次很小的 /catalog(目录+已缓存缩略图,秒回),缺失的缩略图从 Worker 流式返回,
  // 一张一张经 onNsfwPreview 事件补进来(见下方订阅)。force=false 时先吃 module 级 memo(重开面板零请求);
  // force=true(点刷新)强制重拉并起冷却。
  const load = async (force: boolean) => {
    if (!force && galleryMemo && Date.now() - galleryMemo.at < NSFW_GALLERY_MEMO_MS) {
      setCatalog({ pets: galleryMemo.pets, backgrounds: galleryMemo.backgrounds })
      setPreviews(galleryMemo.previews)
      return
    }
    setErr('')
    const r = await window.forge.nsfwGallery?.(force).catch(() => null)
    if (!r) { setErr('加载失败'); setCatalog({ pets: [], backgrounds: [] }); return }
    if ('error' in r) {
      setErr(r.error)                                              // rateLimited 或真错误 → 保留现有内容
      if (!catalog) setCatalog({ pets: [], backgrounds: [] })
      if (r.rateLimited) setCooldownUntil(Date.now() + NSFW_PREVIEW_COOLDOWN_MS)
      return
    }
    galleryMemo = { at: Date.now(), pets: r.pets, backgrounds: r.backgrounds, previews: { ...r.previews } }
    setCatalog({ pets: r.pets, backgrounds: r.backgrounds })
    setPreviews(r.previews)                                        // 已缓存的先出;缺的靠下方事件流补
    setCooldownUntil(Date.now() + NSFW_PREVIEW_COOLDOWN_MS)
  }
  // 进度订阅:每张流式到达的缩略图补进 previews + memo(挂载时订阅一次,跨 load 持续生效)。
  useEffect(() => {
    return window.forge.onNsfwPreview?.(({ key, url }) => {
      setPreviews(prev => (prev[key] === url ? prev : { ...prev, [key]: url }))
      if (galleryMemo) galleryMemo.previews[key] = url
    })
  }, [])
  useEffect(() => { void load(false) }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const activateBg = async (b: NsfwBg) => {
    const key = 'bg:' + b.id
    setBusy(key); setErr('')
    try {
      const stored = nsfwInstalled[key]
      if (stored) {
        const chk = await window.forge.nsfwBgExists?.(stored)
        // bgWallpaperId: '' — an NSFW background is NOT a built-in wallpaper, so clear the gallery
        // highlight (else the previously-selected built-in tile stays checked after applying this).
        if (chk?.exists) { onChangeAppearance({ bgImage: stored, bgScope: 'app', bgWallpaperId: '' }); return }
      }
      const r = await window.forge.nsfwInstallBg?.(b) // re-download (first install, or local file gone)
      if (!r || 'error' in r) { setErr(r && 'error' in r ? r.error : '安装失败'); return }
      onChangeAppearance({ bgImage: r.url, bgScope: 'app', bgWallpaperId: '' })
      onSetInstalled(key, r.url)
    } finally { setBusy(null) }
  }

  const activatePet = async (p: NsfwPet) => {
    const key = 'pet:' + p.id
    setBusy(key); setErr('')
    try {
      const localId = nsfwInstalled[key]
      if (localId && (pet.customPets ?? []).some(cp => cp.id === localId)) {
        onChangePet({ activeCustomPetId: localId, skin: 'custom' }); return // still in the library → just activate
      }
      if ((pet.customPets ?? []).length >= PET_CUSTOM_MAX) { setErr(`自定义宠物已达上限 ${PET_CUSTOM_MAX} 个`); return }
      const id = genPetId()
      const r = await window.forge.nsfwInstallPet?.(id, p) // first install, or it was removed from the library
      if (!r || 'error' in r) { setErr(r && 'error' in r ? r.error : '安装失败'); return }
      const next = addCustomPet(pet.customPets ?? [], { id, name: r.name, images: r.images })
      onChangePet({ skin: 'custom', customPets: next, activeCustomPetId: id })
      onSetInstalled(key, id)
    } finally { setBusy(null) }
  }

  const card = (key: string, name: string, desc: string | undefined, onClick: () => void) => {
    const busyThis = busy === key
    const installed = !!nsfwInstalled[key]
    const thumb = previews[key]
    return (
      <div key={key} className="nsfw-card">
        <div className="nsfw-thumb">
          {thumb ? <img src={thumb} alt="" /> : <span className="nsfw-thumb-ph">预览加载中…</span>}
        </div>
        <div className="nsfw-meta">
          <div className="nsfw-name">{name}</div>
          <div className="nsfw-desc">{desc || '暂无说明'}</div>
        </div>
        <button className="wf-pick nsfw-install" disabled={busyThis || !!busy} onClick={onClick}>
          {busyThis ? '处理中…' : installed ? '设置' : '安装'}
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="set-group">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h4 style={{ margin: 0 }}>扩展内容</h4>
          <button
            className="wf-pick"
            style={{ fontSize: 11, padding: '2px 8px' }}
            disabled={cooldownLeft > 0}
            title={cooldownLeft > 0 ? `刚刷新过,${cooldownLeft}s 后可再刷新` : '重新拉取一次(每次一个请求)'}
            onClick={() => void load(true)}
          >{cooldownLeft > 0 ? `刷新 (${cooldownLeft}s)` : '刷新'}</button>
        </div>
        <p className="set-desc">已激活的额外宠物与背景图。「安装」= 首次下载并应用;「设置」= 已下载过,直接应用(本地图不在了会自动重下)。</p>
        <p className="set-desc" style={{ color: 'var(--faint)', fontSize: 11 }}>
          免责声明:以上图片均来源于网络,版权归原作者所有,仅供个人私下学习交流使用,请勿传播或用于商业用途;如涉及侵权请联系删除。使用者须自行确保符合当地法律法规。
        </p>
        {err && <p className="set-desc" style={{ color: 'var(--del, var(--err))' }}>{err}</p>}
        {!catalog && <p className="set-desc">加载中…</p>}
      </div>

      {catalog && catalog.pets.length > 0 && (
        <div className="set-group">
          <h4>宠物</h4>
          <p className="set-desc">额外的桌面宠物形象,应用后在「宠物」设置里为当前宠物。</p>
          <div className="nsfw-list">{catalog.pets.map(p => card('pet:' + p.id, p.name, p.desc, () => void activatePet(p)))}</div>
        </div>
      )}

      {catalog && catalog.pets.length > 0 && catalog.backgrounds.length > 0 && <hr className="nsfw-divider" />}

      {catalog && catalog.backgrounds.length > 0 && (
        <div className="set-group">
          <h4>背景图</h4>
          <p className="set-desc">额外的应用背景图,应用后设为当前应用背景。</p>
          <div className="nsfw-list">{catalog.backgrounds.map(b => card('bg:' + b.id, b.name, b.desc, () => void activateBg(b)))}</div>
        </div>
      )}

      {catalog && catalog.pets.length === 0 && catalog.backgrounds.length === 0 && !err && (
        <div className="set-group"><p className="set-desc">暂无可用内容。</p></div>
      )}

      <hr className="nsfw-divider" />
      <div className="set-group">
        <h4>关闭扩展</h4>
        <p className="set-desc">关闭后将隐藏此扩展入口,需要重新兑换才能再次开启。已应用的宠物 / 背景不受影响,可在对应设置里自行更换。</p>
        <button
          className="wf-pick"
          style={{ color: 'var(--del, var(--err))', borderColor: 'color-mix(in oklab, var(--del, var(--err)) 45%, var(--border))' }}
          onClick={() => { if (window.confirm('确定关闭此扩展吗?关闭后入口会隐藏,需要重新兑换才能再次开启。')) onDisable() }}
        >
          关闭此扩展
        </button>
      </div>
    </>
  )
}
