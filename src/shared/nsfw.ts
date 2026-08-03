// License-gated extra content (pets + backgrounds) delivered from a private Cloudflare Worker. The
// OPEN-SOURCE app contains ONLY this Worker URL — never any keys, image URLs, or the content itself.
// A user enters an activation code; the app asks the Worker to validate it; on success the code is kept
// locally and used to fetch the gated catalog + image bytes (the Worker proxies bytes, so there is no
// permanent shareable image URL). See cloudflare/nsfw-worker.js for the server side.
//
// Ships EMPTY on purpose: with no URL the feature is dormant (the redeem field says "未配置"). Set this
// to your deployed Worker base URL (e.g. 'https://your-name.workers.dev') to activate it.
export const NSFW_WORKER_URL = 'https://shy-brook-d3cf.interview.workers.dev'

export function nsfwConfigured(): boolean {
  return NSFW_WORKER_URL.trim().length > 0
}

// A downloadable pet: one image per listed state (idle required; missing states fall back to idle at
// render time). States are the standard PetState strings. `desc` is an optional one-line description
// shown under the name (set it in the Worker's CATALOG so users can tell what an item is).
export interface NsfwPet {
  id: string
  name: string
  states: string[]
  desc?: string
}

export interface NsfwBg {
  id: string
  name: string
  desc?: string
}

export interface NsfwCatalog {
  pets: NsfwPet[]
  backgrounds: NsfwBg[]
}

// Gallery result (design E — streaming proxy). The main process fetches the small /catalog (metadata),
// resolves whatever thumbnails are already cached on disk, and returns this immediately; the STILL-MISSING
// thumbnails then stream in from the Worker and arrive one-by-one via onNsfwPreview events. `previews`
// maps a card key ("pet:<id>" / "bg:<id>") to the on-disk forge-bg:// URL — only the already-cached ones
// are populated here; the rest fill in progressively.
export interface NsfwGallery {
  pets: NsfwPet[]
  backgrounds: NsfwBg[]
  previews: Record<string, string>
  rateLimited?: boolean
}
// One progressive thumbnail: emitted (main → renderer) as each streamed image is decoded + stored.
export interface NsfwPreviewEvent { key: string; url: string }

// The token-bucket-limited /catalog gates gallery loads; the client also greys out 刷新 for this long so a
// user can't spam it. Kept in sync with the Worker's RL_* constants.
export const NSFW_PREVIEW_COOLDOWN_MS = 15_000
// The renderer reuses the last successful gallery for this long across pane re-mounts without re-hitting
// the Worker at all — a normal Settings re-open costs ZERO requests; only an explicit 刷新 (or an expired
// window) fetches again.
export const NSFW_GALLERY_MEMO_MS = 5 * 60_000
