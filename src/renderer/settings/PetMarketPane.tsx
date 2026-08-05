import { useEffect, useRef, useState } from 'react'
import type { Pet } from '@shared/types'
import { addCustomPet } from '@shared/petCustom'
import { CODEX_PET_MARKET_SITE, marketLocalId, type CodexMarketPet, type CodexMarketPage } from '@shared/codexPetMarket'

// 缩略图缓存(会话级):previewUrl → forge-bg url。翻页来回不重复下载。
const previewCache = new Map<string, string>()

interface Props {
  pet: Pet
  onChange: (partial: Partial<Pet>) => void
}

// codex-pets.net 宠物市场:翻页浏览第三方社区宠物,点击安装进本地宠物系统。所有网络走主进程(免 CORS)。
export function PetMarketPane({ pet, onChange }: Props) {
  const [page, setPage] = useState(1)
  const [reloadN, setReloadN] = useState(0)
  const [data, setData] = useState<CodexMarketPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installErr, setInstallErr] = useState<string | null>(null)
  const reqRef = useRef(0)

  const installedIds = new Set((pet.customPets ?? []).map(p => p.id))
  const isInstalled = (item: CodexMarketPet) => installedIds.has(marketLocalId(item.id))

  useEffect(() => {
    const my = ++reqRef.current
    setLoading(true); setError(null)
    const req = window.forge?.codexMarketCatalog?.(page)
    if (!req) { setLoading(false); setError('宠物市场不可用'); return }
    req.then(res => {
      if (my !== reqRef.current) return
      if ('error' in res) { setError(res.error); setData(null) }
      else {
        setData(res)
        for (const item of res.pets) {
          const cached = previewCache.get(item.previewUrl)
          if (cached) { setPreviews(p => ({ ...p, [item.id]: cached })); continue }
          window.forge?.codexMarketPreview?.(item.previewUrl).then(r => {
            if (my !== reqRef.current || !r || !('url' in r)) return
            previewCache.set(item.previewUrl, r.url)
            setPreviews(p => ({ ...p, [item.id]: r.url }))
          }).catch(() => { /* thumbnail best-effort */ })
        }
      }
      setLoading(false)
    }).catch(() => { if (my === reqRef.current) { setError('加载失败'); setLoading(false) } })
  }, [page, reloadN])

  const install = async (item: CodexMarketPet) => {
    if (isInstalled(item) || installing.has(item.id)) return
    setInstalling(s => new Set(s).add(item.id)); setInstallErr(null)
    try {
      const res = await window.forge?.codexMarketInstall?.(item)
      if (res && 'ok' in res && res.ok) {
        const next = addCustomPet(pet.customPets ?? [], res.pet)
        onChange({ skin: 'custom', customPets: next, activeCustomPetId: res.pet.id })
      } else {
        setInstallErr(res && 'error' in res ? res.error : '安装失败')
      }
    } catch { setInstallErr('安装失败') }
    finally { setInstalling(s => { const n = new Set(s); n.delete(item.id); return n }) }
  }

  const totalPages = data?.totalPages ?? 1

  return (
    <div className="set-group pet-market">
      <div className="skins-head">
        <div>
          <h4>宠物市场</h4>
          <p className="skins-sub">来自第三方社区库 <b style={{ color: 'var(--fg-2)' }}>{CODEX_PET_MARKET_SITE}</b> 的宠物,<b style={{ color: 'var(--fg-2)' }}>非本 app 自制</b>,每只都标注作者。点「安装」即下载并启用为当前宠物。</p>
        </div>
      </div>

      {installErr && <div className="pm-err">{installErr}</div>}

      {loading ? (
        <div className="pm-empty">加载中…</div>
      ) : error ? (
        <div className="pm-empty">{error} · <button className="pm-retry" onClick={() => setReloadN(n => n + 1)}>重试</button></div>
      ) : !data || !data.pets.length ? (
        <div className="pm-empty">这一页没有宠物。</div>
      ) : (
        <>
          <div className="pm-grid">
            {data.pets.map(item => {
              const installed = isInstalled(item)
              const busy = installing.has(item.id)
              return (
                <div className="pm-card" key={item.id}>
                  <div className="pm-thumb">
                    {previews[item.id]
                      ? <img src={previews[item.id]} alt={item.displayName} loading="lazy" />
                      : <span className="pm-ph" aria-hidden="true" />}
                  </div>
                  <div className="pm-info">
                    <div className="pm-nm" title={item.displayName}>{item.displayName}</div>
                    {item.ownerName && <div className="pm-by" title={`作者:${item.ownerName}`}>by {item.ownerName}</div>}
                  </div>
                  <button className={`pm-install${installed ? ' on' : ''}`} disabled={installed || busy} onClick={() => install(item)}>
                    {installed ? '已安装' : busy ? '安装中…' : '安装'}
                  </button>
                </div>
              )
            })}
          </div>

          <div className="pm-pager">
            <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>上一页</button>
            <span className="pm-page">{data.page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>下一页</button>
          </div>
          <p className="skins-sub pm-foot">共 {data.total} 只 · 内容与版权归原作者及 {CODEX_PET_MARKET_SITE} 所有。</p>
        </>
      )}
    </div>
  )
}
