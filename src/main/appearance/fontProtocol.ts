import { protocol } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { FONT_SCHEME, resolveFontFileAbs } from './fontStore'
import { logError } from '../log/appLog'

// Serves downloaded font files (woff2) to the renderer. The injected @font-face CSS points its src at
// forge-font://f/<id>/<name>.woff2 (see fontStore.rewriteFontCss), which lands here. Mirrors the
// forge-pet:// / forge-bg:// schemes: a privileged standard+secure scheme so it loads inside the
// http:// dev origin and from CSS without mixed-content blocks.

export function registerFontScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: FONT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

export function handleFontProtocol(): void {
  protocol.handle(FONT_SCHEME, async (request) => {
    // forge-font://f/<id>/<name>.woff2 — host is a fixed "f", the rest is the on-disk relpath.
    let rel: string
    try { rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')) } catch { return new Response('bad url', { status: 400 }) }
    const abs = resolveFontFileAbs(rel)
    if (!abs || !existsSync(abs)) {
      try { logError('appearance', `forge-font 未找到: ${request.url} → ${abs ?? '(未解析)'}`) } catch { /* logging must never break serving */ }
      return new Response('not found', { status: 404 })
    }
    // We only ever store woff2. Content is immutable per path (files never change in place), so cache hard.
    return new Response(readFileSync(abs), { headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' } })
  })
}
