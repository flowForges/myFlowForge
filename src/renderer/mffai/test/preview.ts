// 视觉核对(08b R25):把 jsdom 里渲染好的 DOM 连同 app 真实的 CSS 写成静态 HTML,再用无头 Chrome 截图。
// 自己不渲染任何东西;MFFAI_PREVIEW_OUT 给出目录。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const RENDERER = resolve(__dirname, '../..')

export interface PreviewOpts { theme?: string; accent?: string; skin?: string; glass?: boolean; width: number; height: number }

/** 把 @import 原地展开(相对路径) */
function inlineImports(file: string, seen = new Set<string>()): string {
  if (seen.has(file)) return ''
  seen.add(file)
  const src = readFileSync(file, 'utf8')
  return src.replace(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g, (_, p: string) => inlineImports(resolve(dirname(file), p), seen))
}

const cssImports = (file: string) => [...readFileSync(file, 'utf8').matchAll(/^import\s+['"](\.[^'"]+\.css)['"]/gm)].map((m) => resolve(dirname(file), m[1]))

/** 从一个模块顺着相对 import 走,收集它拉进来的 CSS */
function cssReachable(entry: string, seen = new Set<string>(), out: string[] = []): string[] {
  if (seen.has(entry)) return out
  seen.add(entry)
  const src = readFileSync(entry, 'utf8')
  for (const m of src.matchAll(/^import\s+(?:[^'"]*?from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    const p = resolve(dirname(entry), m[1])
    if (p.endsWith('.css')) { if (!out.includes(p)) out.push(p); continue }
    const hit = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((x) => p + x).find((f) => existsSync(f))
    if (hit) cssReachable(hit, seen, out)
  }
  return out
}

/** renderer 入口的 CSS(index.html 的 <link> 和 main.tsx、App.tsx 的 import,按顺序)+ Message.tsx 拉进来的 + mffai.css */
export function previewCss(): string {
  const html = readFileSync(join(RENDERER, 'index.html'), 'utf8')
  const files: string[] = []
  const add = (f: string) => { if (!files.includes(f)) files.push(f) }
  for (const m of html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)) add(resolve(RENDERER, m[1]))
  for (const f of [join(RENDERER, 'main.tsx'), join(RENDERER, 'App.tsx')]) cssImports(f).forEach(add)
  cssReachable(join(RENDERER, 'views/chat/Message.tsx')).forEach(add)
  const mffai = join(RENDERER, 'mffai/mffai.css')
  return [...files.filter((f) => f !== mffai).map((f) => inlineImports(f)), inlineImports(mffai)].join('\n')
}

/** 壁纸位:玻璃变体底下垫一块双色渐变,看半透明的面板能不能透出来 */
const GLASS_BG = 'linear-gradient(135deg, oklch(55% .12 250), oklch(60% .14 20))'

export function writePreview(name: string, opts: PreviewOpts): void {
  const dir = process.env.MFFAI_PREVIEW_OUT
  if (!dir) throw new Error('MFFAI_PREVIEW_OUT is not set')
  mkdirSync(dir, { recursive: true })
  const root = document.documentElement.cloneNode(true) as HTMLElement
  root.setAttribute('data-theme', opts.theme ?? 'dark')
  for (const [k, v] of [['data-accent', opts.accent], ['data-skin', opts.skin]] as const) {
    if (v) root.setAttribute(k, v)
    else root.removeAttribute(k)
  }
  if (opts.glass) root.setAttribute('data-glass', 'on')
  else root.removeAttribute('data-glass')
  const head = root.querySelector('head')!
  head.innerHTML = ''
  const meta = document.createElement('meta')
  meta.setAttribute('charset', 'utf-8')
  const style = document.createElement('style')
  style.textContent = previewCss()
  head.append(meta, style)
  const body = root.querySelector('body')!
  body.querySelectorAll('script').forEach((s) => s.remove())
  body.setAttribute('style', [
    'margin:0', `width:${opts.width}px`, `height:${opts.height}px`, 'overflow:hidden', 'display:flex', 'flex-direction:column',
    `background:${opts.glass ? GLASS_BG : 'var(--bg)'}`, 'color:var(--fg)', 'font-family:var(--font)', 'font-size:13px',
  ].join(';'))
  for (const c of [...body.children]) (c as HTMLElement).setAttribute('style', 'flex:1;min-height:0;display:flex;flex-direction:column')
  writeFileSync(join(dir, `${name}.html`), `<!doctype html>\n${root.outerHTML}\n`)
}
