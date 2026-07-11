// Cloudflare Worker — license gate + content proxy for myFlowForge's extra (NSFW) pet/background packs.
//
// The open-source app knows ONLY this Worker's URL. Activation codes, the catalog, and the images all
// live HERE (private), never in the app. The Worker proxies image BYTES (no permanent public URL), so a
// leaked code can't be turned into a shareable link — each request must carry a valid code.
//
// ── Deploy (all in the Cloudflare dashboard, no CLI needed) ─────────────────────────────────────────
// 1. dash.cloudflare.com → Workers & Pages → Create → Worker. Paste this file. Deploy. You get a URL
//    like https://your-name.workers.dev — put THAT into src/shared/nsfw.ts (NSFW_WORKER_URL).
// 2. Worker → Settings → Variables:
//      • Secret  CODES   = comma-separated activation codes, e.g.  A1B2-C3D4-E5F6,Z9Y8-X7W6-V5U4
//      • (choose ONE way to store images, below)
// 3a. Simplest (no credit card): host the images somewhere with direct URLs (e.g. a SEPARATE GitHub
//     repo served via jsDelivr) and set a plaintext var  CATALOG  to a JSON string describing them:
//       {"pets":[{"id":"kitsune","name":"狐娘","states":["idle","working","confirm","input","done"],
//                 "base":"https://cdn.jsdelivr.net/gh/you/private-content@main/kitsune"}],
//        "backgrounds":[{"id":"bg1","name":"背景1","url":"https://cdn.jsdelivr.net/gh/you/.../bg1.webp"}]}
//     Per-state pet image URL is `${pet.base}/${state}.webp` (adjust the ext in fetchPetImage if needed).
// 3b. Private (Cloudflare R2): create an R2 bucket, bind it to this Worker as `BUCKET`, upload objects
//     at keys `pets/<id>/<state>.webp` and `bg/<id>.webp`, and set CATALOG to the same JSON minus the
//     URLs (the Worker reads from R2 by key). Toggle USE_R2 below.
//
// ── Endpoints the app calls ─────────────────────────────────────────────────────────────────────────
//   POST /unlock              body {code}            → 200 {ok:true} | 403
//   GET  /catalog?key=CODE                           → 200 {pets:[...],backgrounds:[...]} | 403
//   GET  /content/pet/<id>/<state>?key=CODE          → image bytes | 403/404
//   GET  /content/bg/<id>?key=CODE                   → image bytes | 403/404

const USE_R2 = false // set true if you bound an R2 bucket as `BUCKET` (option 3b)

function validCodes(env) {
  return new Set((env.CODES || '').split(',').map(s => s.trim()).filter(Boolean))
}
function checkKey(env, key) {
  return !!key && validCodes(env).has(key.trim())
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } })
}
function catalog(env) {
  try { return JSON.parse(env.CATALOG || '{"pets":[],"backgrounds":[]}') } catch { return { pets: [], backgrounds: [] } }
}

const CT_BY_EXT = { webp: 'image/webp', png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

async function fetchImage(env, url, r2key, ext) {
  const ct = CT_BY_EXT[ext] || 'image/webp'
  if (USE_R2) {
    const obj = await env.BUCKET.get(r2key)
    if (!obj) return new Response('not found', { status: 404 })
    return new Response(obj.body, { headers: { 'content-type': ct, 'cache-control': 'no-store' } })
  }
  if (!url) return new Response('not found', { status: 404 })
  const upstream = await fetch(url)
  if (!upstream.ok) return new Response('not found', { status: 404 })
  return new Response(upstream.body, { headers: { 'content-type': upstream.headers.get('content-type') || ct, 'cache-control': 'no-store' } })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'POST' && path === '/unlock') {
      let code = ''
      try { code = (await request.json()).code } catch { /* bad body */ }
      return checkKey(env, code) ? json({ ok: true }) : json({ ok: false }, 403)
    }

    const key = url.searchParams.get('key')
    if (!checkKey(env, key)) return json({ error: 'forbidden' }, 403)

    if (path === '/catalog') {
      const c = catalog(env)
      // Strip upstream URLs from the response — the app only needs ids/names/states, not locations.
      return json({
        pets: (c.pets || []).map(p => ({ id: p.id, name: p.name, states: p.states || ['idle'] })),
        backgrounds: (c.backgrounds || []).map(b => ({ id: b.id, name: b.name })),
      })
    }

    let m = path.match(/^\/content\/pet\/([^/]+)\/([^/]+)$/)
    if (m) {
      const [, id, state] = m
      const pet = catalog(env).pets.find(p => p.id === id)
      if (!pet) return new Response('not found', { status: 404 })
      const ext = pet.ext || 'webp' // set "ext":"jpg" (or png/gif) in CATALOG if your files aren't webp
      return fetchImage(env, pet.base ? `${pet.base}/${state}.${ext}` : undefined, `pets/${id}/${state}.${ext}`, ext)
    }
    m = path.match(/^\/content\/bg\/([^/]+)$/)
    if (m) {
      const [, id] = m
      const bg = catalog(env).backgrounds.find(b => b.id === id)
      if (!bg) return new Response('not found', { status: 404 })
      const ext = bg.ext || (bg.url ? (bg.url.split('.').pop() || 'webp').toLowerCase() : 'webp')
      return fetchImage(env, bg.url, `bg/${id}.${ext}`, ext) // for jsDelivr, bg.url is the full image URL
    }

    return new Response('not found', { status: 404 })
  },
}
