import { petImageUrl } from '@shared/petImageUrl'

// The 5 built-in pet packs (assets/pet-packs/<id>/<state>.gif) are BUNDLED into the renderer here, so the
// default pets render as ordinary Vite assets (./assets/xxx.gif under file://) — the exact mechanism the
// app already uses for its other bundled images — instead of depending on the forge-pet:// custom
// protocol. That protocol serves USER-uploaded images, but as the app's only custom-scheme consumer it
// was never runtime-verified, and the default pets were showing blank (the <img> request never resolving,
// so not even the SVG fallback fired). Bundling sidesteps it entirely for the built-ins.
//
// Glob keys look like '/…/assets/pet-packs/china-dragon/png/idle.png'; match by the '<id>/png/<state>.png'
// tail. We bundle the per-state PNGs (the full centred poses), matching builtinPetImagePath.
// `import.meta as any`: this module is pulled into the node tsconfig too (via its own .test.ts, which
// that config globs in), and the node config lacks vite/client types — so reference glob dynamically.
const builtinAssets = (import.meta as unknown as { glob: (p: string, o: object) => Record<string, string> }).glob(
  '../../../assets/pet-packs/*/png/*.png',
  { eager: true, query: '?url', import: 'default' },
) as Record<string, string>

export function builtinAssetUrl(stored: string): string | undefined {
  const sub = stored.replace(/^builtin\//, '') // '<id>/png/<state>.png'
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
