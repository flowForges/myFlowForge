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
