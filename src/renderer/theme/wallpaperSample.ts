import { useEffect, useState } from 'react'
import type { Appearance } from '@shared/types'
import { TUNING, extractPalette, wallpaperSourceFor, type WallpaperPalette } from './wallpaperPalette'

// ============================================================================
// 壁纸取样:把壁纸交给浏览器自己的解码器,画进一张 64×64 的离屏 canvas,再把像素读回来喂给
// extractPalette。整个「识别」就是这么回事 —— 不需要任何图像识别库,也不需要主进程解码(不引入 sharp
// 这类原生依赖,那会拖累 mac 双架构打包)。
//
// ★ forge-bg:// 必须在 backgroundProtocol.ts 里开 corsEnabled 并回 Access-Control-Allow-Origin,
//   否则它相对渲染进程是跨源的,drawImage 会污染 canvas,getImageData 直接抛 SecurityError。
//
// 缓存:壁纸 URL 是内容寻址的(forge-bg://img/<sha1>.<ext>),同一 URL 的字节永不变 → 结果可以无限期缓存。
// 内存 Map 挡住同一次会话里的重复取样,localStorage 挡住重启后的重复取样(宠物窗与主窗同源,天然共享)。
// ============================================================================

const LS_KEY = 'forge.wpPalette.v1'
const LS_MAX = 40

const memo = new Map<string, WallpaperPalette | null>()
const inflight = new Map<string, Promise<WallpaperPalette | null>>()

function readStore(): Record<string, WallpaperPalette> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    const obj = raw ? JSON.parse(raw) : null
    return obj && typeof obj === 'object' ? obj as Record<string, WallpaperPalette> : {}
  } catch { return {} }
}

function writeStore(url: string, p: WallpaperPalette): void {
  try {
    const store = readStore()
    store[url] = p
    // 简单封顶:超了就丢掉最早写入的若干条(对象键序即插入序)。
    const keys = Object.keys(store)
    for (const k of keys.slice(0, Math.max(0, keys.length - LS_MAX))) delete store[k]
    localStorage.setItem(LS_KEY, JSON.stringify(store))
  } catch { /* 缓存写失败无所谓,下次重算 */ }
}

/** 同步查缓存(内存 → localStorage),没有则返回 null。给首帧用,避免闪一下默认配色。 */
export function peekWallpaperPalette(url: string): WallpaperPalette | null {
  if (!url) return null
  const hit = memo.get(url)
  if (hit !== undefined) return hit
  const stored = readStore()[url]
  if (stored) { memo.set(url, stored); return stored }
  return null
}

async function sample(url: string): Promise<WallpaperPalette | null> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await new Promise<void>((res, rej) => {
    if (img.complete && img.naturalWidth > 0) return res()
    img.onload = () => res()
    img.onerror = () => rej(new Error('壁纸加载失败'))
  })
  const S = TUNING.SAMPLE
  const canvas = document.createElement('canvas')
  canvas.width = S
  canvas.height = S
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, S, S)   // 浏览器顺手完成降采样
  return extractPalette(ctx.getImageData(0, 0, S, S).data)
}

/** 取(或算)一张壁纸的调色板。失败只记内存、不落缓存,下次还会重试。 */
export function loadWallpaperPalette(url: string): Promise<WallpaperPalette | null> {
  if (!url) return Promise.resolve(null)
  const hit = peekWallpaperPalette(url)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(url)
  if (running) return running
  const task = sample(url)
    .catch(() => null)
    .then(p => {
      memo.set(url, p)
      if (p) writeStore(url, p)
      inflight.delete(url)
      return p
    })
  inflight.set(url, task)
  return task
}

/**
 * 当前外观对应的壁纸调色板。默认只在开关打开时才真去取样;设置页要预览「打开会变成什么样」,
 * 传 always 让它无论开关都算(结果有缓存,代价可忽略)。
 */
export function useWallpaperPalette(a: Appearance | undefined, opts?: { always?: boolean }): WallpaperPalette | null {
  const always = !!opts?.always
  const wanted = always || !!a?.autoWallpaperTheme
  const url = wanted ? wallpaperSourceFor(a) : ''
  const [palette, setPalette] = useState<WallpaperPalette | null>(() => peekWallpaperPalette(url))
  useEffect(() => {
    if (!url) { setPalette(null); return }
    const cached = peekWallpaperPalette(url)
    if (cached) { setPalette(cached); return }
    let cancelled = false
    loadWallpaperPalette(url).then(p => { if (!cancelled) setPalette(p) })
    return () => { cancelled = true }
  }, [url])
  return url ? palette : null
}
