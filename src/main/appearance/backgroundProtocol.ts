import { protocol } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { BG_MIME_BY_EXT, BG_SCHEME, resolveBackgroundAbs } from './backgroundStore'
import { logError } from '../log/appLog'

// Custom scheme that serves on-disk background images (see backgroundStore.ts). Mirrors forge-pet://:
// file:// isn't reliable across the http:// dev origin and file:// prod origin, so
// url("forge-bg://img/<hash>.<ext>") loads natively through this handler in every window.

// MUST run before app 'ready' (privileged schemes can only be declared at that point). `secure` +
// `standard` let the scheme load inside the http:// dev origin (and CSS url()) without mixed-content blocks.
// `corsEnabled` (+ the ACAO header below) additionally lets the renderer read the decoded PIXELS back:
// the wallpaper auto-theming samples the image into a canvas, and without CORS this scheme is cross-origin
// to the renderer, so drawImage would taint the canvas and getImageData would throw SecurityError.
export function registerBackgroundScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: BG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
  ])
}

// Register the request handler. Call once, after app is ready.
export function handleBackgroundProtocol(): void {
  protocol.handle(BG_SCHEME, async (request) => {
    // forge-bg://img/<hash>.<ext> — host is a fixed "img", the whole relpath is the pathname.
    let rel: string
    try { rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')) } catch { return new Response('bad url', { status: 400 }) }
    const abs = resolveBackgroundAbs(rel)
    if (!abs || !existsSync(abs)) {
      try { logError('appearance', `forge-bg 未找到: ${request.url} → ${abs ?? '(未解析)'}`) } catch { /* logging must never break serving */ }
      return new Response('not found', { status: 404 })
    }
    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase()
    const mime = BG_MIME_BY_EXT[ext] ?? 'application/octet-stream'
    // Content-addressed filename → bytes for a given URL never change, so cache aggressively.
    return new Response(readFileSync(abs), {
      headers: {
        'content-type': mime,
        'cache-control': 'public, max-age=31536000, immutable',
        // 见上:让渲染进程能以 crossOrigin="anonymous" 加载并读回像素(壁纸取色)。图片本来就是本地文件,
        // 且此 scheme 只服务 backgrounds 目录内(resolveBackgroundAbs 做了越界防护),放开无额外暴露面。
        'access-control-allow-origin': '*',
      },
    })
  })
}
