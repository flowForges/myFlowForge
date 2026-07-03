// Map a stored custom-pet image value to a src usable in <img>. Values are now on-disk relative
// paths ("<petId>/<state>.<ext>") served via the forge-pet:// protocol. Legacy/transient data URLs
// (older settings not yet migrated, or an in-memory preview) are passed straight through.
export function petImageUrl(stored: string | undefined): string | undefined {
  if (!stored) return undefined
  if (stored.startsWith('data:')) return stored
  const rel = stored.split('/').map(encodeURIComponent).join('/')
  return `forge-pet://img/${rel}`
}
