// Injects the rewritten @font-face CSS for every downloaded font (see main/appearance/fontStore) into a
// single <style> tag, making those fonts usable app-wide — the font picker just sets --font to one of
// their families. Idempotent: re-running replaces the tag's content. Returns the downloaded families so
// callers can offer them in the picker. Safe to call before any font is downloaded (injects nothing).
const STYLE_ID = 'forge-downloaded-fonts'

export async function injectDownloadedFontFaces(): Promise<{ id: string; family: string }[]> {
  let list: { id: string; family: string; css: string }[] = []
  try { list = (await window.forge?.fontsListDownloaded?.()) ?? [] } catch { list = [] }
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = list.map(f => f.css).join('\n')
  return list.map(({ id, family }) => ({ id, family }))
}
