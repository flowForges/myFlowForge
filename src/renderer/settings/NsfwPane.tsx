import { useEffect, useState } from 'react'
import type { Pet, Appearance } from '@shared/types'
import type { NsfwCatalog, NsfwPet, NsfwBg } from '@shared/nsfw'
import { addCustomPet, PET_CUSTOM_MAX } from '@shared/petCustom'

let seq = 0
const genPetId = () => `pet-${Date.now()}-${seq++}-${Math.round(Math.random() * 1e6)}`

interface NsfwPaneProps {
  pet: Pet
  nsfwInstalled: Record<string, string>          // catalog key → local ref (bg: forge-bg:// URL; pet: customPets id)
  onChangePet: (p: Partial<Pet>) => void
  onChangeAppearance: (p: Partial<Appearance>) => void
  onSetInstalled: (key: string, ref: string) => void
}

// The gated extra-content pane (reachable only after activation). Two-state per item:
//   安装 — never downloaded → download, store on disk, apply, remember it.
//   设置 — downloaded before → if the local file is still there just apply it; if it was deleted/GC'd,
//          re-download then apply. Nothing is held in memory: images live on disk, served via protocol.
export function NsfwPane({ pet, nsfwInstalled, onChangePet, onChangeAppearance, onSetInstalled }: NsfwPaneProps) {
  const [catalog, setCatalog] = useState<NsfwCatalog | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, string>>({}) // key → forge-bg:// URL (on-disk cache)

  const load = () => {
    setErr(''); setCatalog(null); setPreviews({})
    void window.forge.nsfwCatalog?.().then(r => {
      if (!r) { setErr('加载失败'); setCatalog({ pets: [], backgrounds: [] }); return }
      if ('error' in r) { setErr(r.error); setCatalog({ pets: [], backgrounds: [] }); return }
      setCatalog(r)
      for (const p of r.pets) void loadPreview('pet:' + p.id, 'pet', p.id)
      for (const b of r.backgrounds) void loadPreview('bg:' + b.id, 'bg', b.id)
    }).catch(() => { setErr('加载失败'); setCatalog({ pets: [], backgrounds: [] }) })
  }
  const loadPreview = async (key: string, kind: 'pet' | 'bg', id: string) => {
    const r = await window.forge.nsfwPreview?.(kind, id)
    if (r && 'url' in r) setPreviews(prev => ({ ...prev, [key]: r.url }))
  }
  useEffect(load, [])

  const activateBg = async (b: NsfwBg) => {
    const key = 'bg:' + b.id
    setBusy(key); setErr('')
    try {
      const stored = nsfwInstalled[key]
      if (stored) {
        const chk = await window.forge.nsfwBgExists?.(stored)
        if (chk?.exists) { onChangeAppearance({ bgImage: stored, bgScope: 'app' }); return }
      }
      const r = await window.forge.nsfwInstallBg?.(b) // re-download (first install, or local file gone)
      if (!r || 'error' in r) { setErr(r && 'error' in r ? r.error : '安装失败'); return }
      onChangeAppearance({ bgImage: r.url, bgScope: 'app' })
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
          <button className="wf-pick" style={{ fontSize: 11, padding: '2px 8px' }} onClick={load}>刷新</button>
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
    </>
  )
}
