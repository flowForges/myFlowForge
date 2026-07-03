import { app, protocol } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { MIME_BY_EXT, resolvePetImageAbs } from './petImageStore'
import { logError } from '../log/appLog'

// Custom scheme that serves on-disk pet images to the renderer. We can't use file:// reliably
// (dev pages are http:// origin, prod is file://, and there's no protocol otherwise registered),
// so <img src="forge-pet://img/<relpath>"> loads natively through this handler in both windows.
export const PET_SCHEME = 'forge-pet'

// MUST run before app 'ready' (privileged schemes can only be declared at that point). `secure` +
// `standard` let the scheme load inside the http:// dev origin without mixed-content/CSP blocks.
export function registerPetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
}

// Register the request handler. Call once, after app is ready.
export function handlePetProtocol(): void {
  protocol.handle(PET_SCHEME, async (request) => {
    // forge-pet://img/<petId>/<state>.<ext> — host is a fixed "img", the whole relpath is the pathname.
    let rel: string
    try { rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, '')) } catch { return new Response('bad url', { status: 400 }) }
    const abs = rel.startsWith('builtin/')
      ? resolveBuiltinPetImageAbs(rel)
      : resolvePetImageAbs(rel)
    if (!abs || !existsSync(abs)) {
      // Log misses so a blank pet is diagnosable from the log (built-ins now load as bundled assets, but
      // user-uploaded images still come through here). Never throw — the <img> onError handles the 404.
      try { logError('pet', `forge-pet 未找到: ${request.url} → ${abs ?? '(未解析)'}`) } catch { /* logging must never break serving */ }
      return new Response('not found', { status: 404 })
    }
    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase()
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    // no-store: a state's image can be replaced in place (same relpath), so caching would show stale.
    return new Response(readFileSync(abs), { headers: { 'content-type': mime, 'cache-control': 'no-store' } })
  })
}

export function builtinPetRoots(): string[] {
  return app.isPackaged
    ? [join(process.resourcesPath, 'builtin-pet-packs')]
    : [
        join(app.getAppPath(), 'assets', 'pet-packs'),
        join(process.cwd(), 'assets', 'pet-packs'),
      ]
}

export function resolveBuiltinPetImageAbs(rel: string): string | null {
  const builtinRel = rel.replace(/^builtin\/+/, '')
  for (const root of builtinPetRoots()) {
    const safeRoot = resolve(root)
    const abs = resolve(safeRoot, builtinRel)
    if (abs !== safeRoot && !abs.startsWith(safeRoot + sep)) continue
    if (existsSync(abs)) return abs
  }
  return null
}
