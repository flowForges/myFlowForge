import { useEffect, useState } from 'react'
import type { Pet } from '@shared/types'
import type { PetPackCatalog, PetPackItem } from '@shared/petPack'
import { addCustomPet, PET_CUSTOM_MAX } from '@shared/petCustom'

interface PetGalleryProps {
  pet: Pet
  onChange: (partial: Partial<Pet>) => void
}

// Deterministic local id per pack → installing twice upserts (no dupes), and "installed" = this id exists.
const localId = (packId: string) => `pack-${packId}`

// Downloadable pet gallery (no activation code). Lists the public jsDelivr catalog, shows on-disk-cached
// thumbnails, and on click downloads the pack's frames and registers it as a usable custom pet. Only
// white-catgirl ships bundled; everything else is fetched here on demand.
export function PetGallery({ pet, onChange }: PetGalleryProps) {
  const [catalog, setCatalog] = useState<PetPackCatalog | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [thumbs, setThumbs] = useState<Record<string, string>>({}) // packId → forge-bg:// URL

  const load = () => {
    setErr(''); setCatalog(null); setThumbs({})
    void window.forge?.petPackCatalog?.().then(r => {
      if (!r) { setErr('加载失败'); setCatalog({ pets: [] }); return }
      if ('error' in r) { setErr(r.error); setCatalog({ pets: [] }); return }
      setCatalog(r)
      for (const p of r.pets) void loadThumb(p)
    }).catch(() => { setErr('加载失败'); setCatalog({ pets: [] }) })
  }
  const loadThumb = async (p: PetPackItem) => {
    const r = await window.forge?.petPackPreview?.(p)
    if (r && 'url' in r) setThumbs(prev => ({ ...prev, [p.id]: r.url }))
  }
  useEffect(load, [])

  const customList = pet.customPets ?? []
  const activate = (packId: string) => onChange({ skin: 'custom', activeCustomPetId: localId(packId) })

  const install = async (item: PetPackItem) => {
    const id = localId(item.id)
    const already = customList.some(p => p.id === id)
    if (already && pet.activeCustomPetId !== id) { activate(item.id); return } // downloaded already → just use it
    if (!already && customList.length >= PET_CUSTOM_MAX) { setErr(`宠物已达上限 ${PET_CUSTOM_MAX} 个`); return }
    setBusy(item.id); setErr('')
    try {
      const r = await window.forge?.petPackInstall?.(id, item)
      if (!r || 'error' in r) { setErr(r && 'error' in r ? r.error : '下载失败'); return }
      const entry = { id, name: r.name, images: r.images }
      const next = already ? customList.map(p => (p.id === id ? entry : p)) : addCustomPet(customList, entry)
      onChange({ skin: 'custom', customPets: next, activeCustomPetId: id })
    } finally { setBusy(null) }
  }

  const card = (item: PetPackItem) => {
    const id = localId(item.id)
    const busyThis = busy === item.id
    const installed = customList.some(p => p.id === id)
    const active = pet.activeCustomPetId === id
    const thumb = thumbs[item.id]
    return (
      <button key={item.id} className={`wp-tile${active ? ' on' : ''}`} disabled={busyThis || !!busy} title={item.desc || item.name} onClick={() => void install(item)}>
        <div className="wp-thumb">
          {thumb ? <img src={thumb} alt="" /> : <span className="wp-thumb-ph">加载中…</span>}
          {busyThis && <div className="wp-loading"><span className="wp-spin" />下载中…</div>}
        </div>
        <div className="wp-name">{active ? '● ' : installed ? '✓ ' : ''}{item.name}</div>
      </button>
    )
  }

  return (
    <div className="set-group">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h4 style={{ margin: 0 }}>宠物库</h4>
        <button className="wf-pick" style={{ fontSize: 11, padding: '2px 8px' }} onClick={load}>刷新</button>
      </div>
      <p className="set-desc">
        更多桌面宠物,点一个即下载并启用(不占安装包,按需从网络下载)。已下载的再点即切换使用。
        {err && <span style={{ color: 'var(--del)', marginLeft: 6 }}>{err}</span>}
      </p>
      <p className="set-desc" style={{ color: 'var(--faint)', fontSize: 11 }}>
        免责声明:以上宠物形象均来源于网络,版权归原作者所有,仅供个人学习交流使用,请勿用于商业用途;如涉及侵权请联系删除。
      </p>
      {!catalog && <p className="set-desc">加载中…</p>}
      {catalog && catalog.pets.length === 0 && !err && <p className="set-desc">暂无可下载宠物。</p>}
      {catalog && catalog.pets.length > 0 && <div className="wp-grid">{catalog.pets.map(card)}</div>}
    </div>
  )
}
