import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export function XtermView({ termId, active, visible, font }: {
  termId: string
  active: boolean
  /** 面板真的展开着、并且这一页是当前页。★和 `active` 不是一回事 —— 见 `canFit` 那段。 */
  visible: boolean
  font: { fontFamily: string; fontSize: number }
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  /**
   * ★★量不到尺寸就**一个字都别改**。
   *
   * 2026-09-04 的 bug 根因就在这儿:终端面板收起时用的是 `height: 0`(`shell/dock.css`),
   * **不是 `display: none`** —— 于是这个宿主元素照样在布局里、照样触发 ResizeObserver,
   * FitAddon 也照样量得出一个数:宽度不变、**高度 0 ⇒ rows 被算成 1**(FitAddon 的下限)。
   * 接着 `termResize(termId, cols, 1)` 把**真的那个 pty 也改成了 1 行**。
   * 一个带多行提示符的 shell(zsh/p10k)在 1 行里收到 SIGWINCH 会疯狂重画,于是:
   *   · 回滚里旧的提示符被截成半行(用户原话「终端前面的目录只显示一半」);
   *   · 满屏莫名其妙的换行(「好像有很多回车执行的感觉」);
   *   · 重开之后 ZLE 对宽高的认知已经错了,继续敲字会画错位(「git commit」画成「git coomit」)。
   * 三个症状,一个根因。
   *
   * ★为什么不改成收起时 `display: none` 了事:对 `display:none` 的元素,
   *  `getComputedStyle` 返回的是**计算值**不是使用值 —— `.xterm-host` 写着 `height: 100%`,
   *  拿到的就是字符串 `"100%"`,`parseInt` 得到 100,FitAddon 会当成 100px 去算行数,
   *  比现在还错。所以只能显式判尺寸。
   */
  const canFit = () => {
    const el = elRef.current
    return !!el && el.clientWidth > 0 && el.clientHeight > 0
  }

  useEffect(() => {
    const el = elRef.current!
    const term = new Terminal({ allowProposedApi: true, fontFamily: font.fontFamily, fontSize: font.fontSize,
      cursorBlink: true, theme: readXtermTheme() })
    const fit = new FitAddon(); term.loadAddon(fit); term.loadAddon(new WebLinksAddon())
    term.open(el)
    // GPU renderer: the default DOM renderer repaints rows as DOM nodes and is slow — with a
    // redraw-heavy shell prompt (powerlevel10k/gitstatus) typing feels laggy. The WebGL addon
    // renders on the GPU (far faster). Load AFTER open(); on WebGL context loss, dispose it so
    // xterm transparently falls back to the DOM renderer instead of freezing.
    //
    // BUT only when window.devicePixelRatio is an integer. The WebGL renderer packs glyphs into an
    // integer-pixel GPU atlas; at a FRACTIONAL device-pixel ratio each cell's advance no longer
    // lines up with xterm's fractional cell layout, so echoed characters drift across the row —
    // "git push" renders as "git p ush", the next keystroke as "ggit push …". Our whole-window zoom
    // (setZoomFactor, keyed off the UI font size: 14px = 1.0×, so e.g. 13px → 0.93×) folds into
    // devicePixelRatio, so on a 2× display any non-14px font size makes it fractional (2×0.93≈1.86).
    // Fall back to the DOM renderer there — it lays out via the browser and stays correct at any
    // zoom. Re-evaluate when the ratio changes (the user changes the UI font size).
    let webgl: WebglAddon | null = null
    const syncRenderer = () => {
      const integral = Number.isInteger(window.devicePixelRatio)
      if (integral && !webgl) {
        try {
          const w = new WebglAddon()
          w.onContextLoss(() => { try { w.dispose() } catch { /* already gone */ } })
          term.loadAddon(w); webgl = w
        } catch { /* no WebGL (rare) → stay on the DOM renderer */ }
      } else if (!integral && webgl) {
        try { webgl.dispose() } catch { /* already gone */ }
        webgl = null
        try { term.refresh(0, term.rows - 1) } catch { /* not visible */ }
      }
    }
    syncRenderer()
    // devicePixelRatio has no 'change' event; a resolution media query fires once when it changes,
    // so re-arm a fresh query against the new value each time.
    let dprQuery: MediaQueryList | null = null
    const onDprChange = () => { syncRenderer(); armDpr() }
    const armDpr = () => {
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      dprQuery.addEventListener('change', onDprChange, { once: true })
    }
    armDpr()
    termRef.current = term; fitRef.current = fit
    // ★量得到才 fit;量不到就先用 xterm 的默认 80×24 起步,等下面那个「变可见」的 effect 来纠正。
    //   宁可一开始尺寸不准,也不能把 pty 定成 1 行。
    if (canFit()) fit.fit()
    void window.forge.termResize(termId, term.cols, term.rows)
    const offData = window.forge.onTermData(({ termId: id, data }) => { if (id === termId) term.write(data) })
    term.onData(d => window.forge.termWrite(termId, d))
    // Debounce: a live drag fires the observer every frame; refitting + SIGWINCH on each tick makes the
    // shell redraw its prompt repeatedly (the "staircase"). Refit once the size settles instead.
    let refitTimer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(refitTimer)
      refitTimer = setTimeout(() => {
        // ★收起/切走时 RO 会带着 0 高度触发一次 —— 那一次必须整个跳过,不是「fit 一下就好」。
        if (!canFit()) return
        try { fit.fit(); window.forge.termResize(termId, term.cols, term.rows) } catch { /* not visible */ }
      }, 90)
    })
    ro.observe(el)
    return () => { offData(); dprQuery?.removeEventListener('change', onDprChange); clearTimeout(refitTimer); ro.disconnect(); term.dispose() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termId])

  /**
   * 重新露面(换页 **或者** 面板从收起变成展开)时:重排 → 滚到底 → 聚焦。
   *
   * ★★这里原来盯的是 `active`。可是关掉再打开面板的时候 `active` **压根没变**(还是同一页),
   *  effect 不跑,于是既不重排也不滚到底 —— 用户原话:「打开后不是在终端最底部,滚动条还得再往下滚一下」。
   *  盯 `visible` 才对:它包含了「面板展开了」这件事。
   * ★滚到底不能省:重新展开会把行数从收起时的状态换回来,视口很容易停在缓冲区末尾上面一两行,
   *  正好把你要敲字的那个提示符藏在下面。
   * ★rAF 一帧:面板高度是 CSS 过渡出来的,`visible` 变 true 的**那一刻**元素高度还是 0,
   *  立刻 fit 会又量到 0。等一帧让布局落定;真没落定也没关系 —— `canFit()` 会拦住,
   *  ResizeObserver 随后还会补一次。
   */
  useEffect(() => {
    if (!visible) return
    const id = requestAnimationFrame(() => {
      try {
        if (canFit()) {
          fitRef.current?.fit()
          const t = termRef.current
          if (t) void window.forge.termResize(termId, t.cols, t.rows)
        }
        termRef.current?.scrollToBottom()
        termRef.current?.focus()
      } catch { /* not visible */ }
    })
    return () => cancelAnimationFrame(id)
  }, [visible, termId])
  // Live-apply font changes.
  useEffect(() => {
    const t = termRef.current; if (!t) return
    t.options.fontFamily = font.fontFamily; t.options.fontSize = font.fontSize
    if (!canFit()) return
    try { fitRef.current?.fit(); window.forge.termResize(termId, t.cols, t.rows) } catch { /* */ }
  }, [font.fontFamily, font.fontSize, termId])

  // Live-apply theme changes. The palette lives in CSS vars keyed off <html data-theme>; a NEW
  // terminal reads it on mount, but an already-open one keeps its original theme — so a terminal
  // opened in light mode stayed white after switching to dark. Re-read the palette when data-theme
  // flips so existing terminals recolor too.
  useEffect(() => {
    const t = termRef.current; if (!t) return
    const mo = new MutationObserver(() => { t.options.theme = readXtermTheme() })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [termId])

  return <div className="xterm-host" ref={elRef} style={{ display: active ? 'block' : 'none' }} />
}

// Map the app theme (CSS vars) into an xterm theme object.
function readXtermTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string, fb: string) => (cs.getPropertyValue(n).trim() || fb)
  // selectionInactiveBackground = same as active so the highlight stays visible after the user clicks
  // away to copy (default fades it). See --term-selection (tokens.css) for why xterm needed this.
  const sel = v('--term-selection', 'rgba(120,160,235,0.3)')
  return {
    background: v('--bg', '#0b1020'), foreground: v('--fg-2', '#d6dbe6'), cursor: v('--accent', '#7aa2f7'),
    selectionBackground: sel, selectionInactiveBackground: sel,
  }
}
