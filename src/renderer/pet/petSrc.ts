import { petImageUrl } from '@shared/petImageUrl'

// The built-in pet packs are BUNDLED into the renderer here, so the
// default pets render as ordinary Vite assets (./assets/xxx.gif under file://) — the exact mechanism the
// app already uses for its other bundled images — instead of depending on the forge-pet:// custom
// protocol. That protocol serves USER-uploaded images, but as the app's only custom-scheme consumer it
// was never runtime-verified, and the default pets were showing blank (the <img> request never resolving,
// so not even the SVG fallback fired). Bundling sidesteps it entirely for the built-ins.
//
// Glob keys look like '/…/assets/pet-packs/china-dragon/webp/idle.webp'; match by the stored path tail.
// Built-in packs are animated WebP only (the old png/gif/apng exports were dropped to slim the app).
// `import.meta as any`: this module is pulled into the node tsconfig too (via its own .test.ts, which
// that config globs in), and the node config lacks vite/client types — so reference glob dynamically.
// Only the bundled built-in (white-catgirl) is globbed here — the other packs are downloaded on demand and
// served from disk via forge-pet://, so they must NOT be pulled into the Vite bundle (that was ~28MB of
// webp for packs the user may never use). Keep this glob narrowed to the shipped built-in(s).
const builtinAssets = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob(
  '../../../assets/pet-packs/white-catgirl/webp/*.webp',
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>

export function builtinAssetUrl(stored: string): string | undefined {
  const sub = stored.replace(/^builtin\//, '') // '<id>/<format>/<state>.<ext>'
  for (const [key, url] of Object.entries(builtinAssets)) {
    if (key.endsWith('/pet-packs/' + sub)) return url
  }
  return undefined
}

// Resolve a stored pet-image value to a renderer <img> src. Built-in pack paths ('builtin/…') use the
// bundled asset (protocol-independent); everything else (user uploads, data URLs) goes through
// petImageUrl → forge-pet://. Falls back to the protocol URL if a built-in asset isn't found.
export function petSrc(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('builtin/')) return builtinAssetUrl(stored) ?? petImageUrl(stored)
  return petImageUrl(stored)
}
