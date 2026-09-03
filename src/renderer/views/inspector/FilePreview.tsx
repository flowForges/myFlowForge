import { useEffect, useState } from 'react'
import type { ChangeType, DiffLine, FilePreview as FilePreviewData } from '@shared/types'
import { highlight } from './highlight'
import { FileIc } from './fileIcon'
import { Markdown } from '../chat/markdown'
import { Lightbox } from '../../components/Lightbox'
import { isHtmlFile } from '@shared/fileRef'

// Markdown files render as formatted markdown in 全文 mode rather than through the
// per-line code highlighter (which would show raw '#'/'*' syntax). Diff stays line-based.
function isMarkdown(file: string, lang: string): boolean {
  return /\.(md|markdown)$/i.test(file) || lang === 'md' || lang === 'markdown'
}
function isImage(file: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(file)
}

// 文件预览覆盖层 (file preview overlay) — ports the prototype's #preview.
// Diff mode renders gitDiff lines (add/del/ctx + line numbers); 全文 mode renders
// the full file with the pure highlighter's .kw/.st/.cm spans. CSS in inspector.css.

export function FilePreview({
  open,
  cwd,
  file,
  type,
  onClose,
  embedded,
  initialMode
}: {
  open: boolean
  cwd: string
  file: string
  type: ChangeType
  onClose: () => void
  /** When embedded in the full-screen file browser the tree is the back affordance, so hide the ← button. */
  embedded?: boolean
  /** Mode to open in. Defaults to 'diff' (change review); design-doc opens pass 'full' so the
      formatted markdown shows immediately instead of an empty diff for an untracked file. */
  initialMode?: 'diff' | 'full'
}) {
  const [mode, setMode] = useState<'diff' | 'full'>(initialMode ?? 'diff')
  const [diff, setDiff] = useState<DiffLine[]>([])
  const [full, setFull] = useState<FilePreviewData | null>(null)
  const img = isImage(file)
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState('')
  const [zoom, setZoom] = useState(false)
  /** 复制按钮的反馈:'' / 'ok' / 'err'。★复制是**看不见**的动作,不给回执人不知道成没成功。 */
  const [copied, setCopied] = useState<'' | 'ok' | 'err'>('')

  useEffect(() => {
    if (!open || !file) return
    setMode(initialMode ?? 'diff')
    setFull(null)
    setZoom(false)
    // Image files: gitDiff/gitFile return text (binary garbage); read the bytes as a data URL instead.
    if (isImage(file)) {
      setImgUrl(null); setImgErr('')
      void window.forge.imageFile?.(cwd, file).then(r => {
        if (r && 'dataUrl' in r) setImgUrl(r.dataUrl)
        else setImgErr((r && 'error' in r ? r.error : '') || '图片加载失败')
      }).catch(() => setImgErr('图片加载失败'))
      return
    }
    void window.forge.gitDiff(cwd, file).then(setDiff)
  }, [open, cwd, file, initialMode])

  useEffect(() => {
    if (mode === 'full' && full === null && open && file) {
      void window.forge.gitFile(cwd, file).then(setFull)
    }
  }, [mode, full, open, cwd, file])

  // 换文件就把回执清掉 —— 不清的话上一份的「已复制」会挂在新文件的按钮上。
  useEffect(() => { setCopied('') }, [cwd, file])

  /**
   * 复制**这个文件的内容**。
   *
   * ★★复制的永远是文件正文,**不是当前看到的那一屏** —— 在 Diff 模式下按它,拿到的也是整份
   *  文件,而不是带 `+`/`-` 前缀的 diff 片段。用户要的是「复制当前文件内的内容」,而一份
   *  带着 diff 标记的文本粘到哪儿都是坏的(粘进编辑器编译不过,粘给模型是噪音)。
   * ★所以 Diff 模式下 `full` 可能还没拉过 —— 点的时候现拉一次,不预取:大部分人打开预览
   *  只是看一眼,为一颗可能不点的按钮多读一次文件不值当。
   */
  const copyFile = async () => {
    try {
      const data = full ?? await window.forge.gitFile(cwd, file)
      if (!full) setFull(data)
      await navigator.clipboard.writeText(data?.text ?? '')
      setCopied('ok')
    } catch {
      // 剪贴板不可用 / 文件读不到。★说出来,不要静默 —— 「点了没反应」会让人以为按钮是坏的,
      //  然后反复点。
      setCopied('err')
    }
    window.setTimeout(() => setCopied(''), 1800)
  }

  return (
    <div className={`preview${open ? ' on' : ''}`}>
      <div className="pv-head">
        {!embedded && (
          <button className="pv-back" title="返回" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="19" y1="12" x2="5" y2="12"></line>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
        )}
        <span className={`pv-tag ${type}`}>{type}</span>
        <FileIc name={file} big />
        <span className="pv-path">{file}</span>
        {!img && (
          <div className="pv-actions">
            {/* .html 产物在预览里只能看源码;想看渲染效果就丢给系统浏览器(app 内嵌 iframe 会把产物里的
                脚本/外链跑在 app 里,不做)。走 file:open-path,主进程会再校验一次越界。 */}
            {isHtmlFile(file) && (
              <button
                className="pv-openbrowser"
                title="用系统浏览器打开"
                onClick={() => { void window.forge.openFilePath?.([cwd], file) }}
              >
                用浏览器打开
              </button>
            )}
            {/* ★★复制排在 Diff/全文 前面:它是对**这个文件**的操作,而那个开关是「怎么看」。
                两者不是一类,挨着摆但不进同一个胶囊。 */}
            <button
              className={`pv-copy${copied ? ' ' + copied : ''}`}
              title="复制这个文件的全部内容"
              onClick={() => void copyFile()}
            >
              {copied === 'ok' ? '已复制' : copied === 'err' ? '复制失败' : '复制'}
            </button>
            <div className="pv-toggle">
              <button
                className={mode === 'diff' ? 'on' : undefined}
                data-pv="diff"
                onClick={() => setMode('diff')}
              >
                Diff
              </button>
              <button
                className={mode === 'full' ? 'on' : undefined}
                data-pv="full"
                onClick={() => setMode('full')}
              >
                全文
              </button>
            </div>
          </div>
        )}
      </div>
      {img ? (
        <div className="pv-img-wrap">
          {imgUrl ? (
            <img
              className="pv-img" src={imgUrl} alt={file}
              role="button" tabIndex={0} title="点击查看大图"
              onClick={() => setZoom(true)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setZoom(true) } }}
            />
          ) : imgErr ? <div className="pv-img-msg">{imgErr}</div>
            : <div className="pv-img-msg">加载中…</div>}
          {zoom && imgUrl ? <Lightbox src={imgUrl} alt={file} onClose={() => setZoom(false)} /> : null}
        </div>
      ) : mode === 'full' && full !== null && isMarkdown(file, full.lang) ? (
        <div className="pv-md">
          {/* relative images in the doc resolve against the doc's own directory */}
          <Markdown text={full.text} imageBaseCwd={file.includes('/') ? `${cwd}/${file.slice(0, file.lastIndexOf('/'))}` : cwd} />
        </div>
      ) : (
      <div className="pv-code">
        {mode === 'diff'
          ? diff.map((l, i) => (
              <div
                key={i}
                className={`code-line${l.kind === 'add' ? ' add' : l.kind === 'del' ? ' del' : ''}`}
              >
                <span className="ln">{l.ln}</span>
                <span className="ct">{l.text}</span>
              </div>
            ))
          : full !== null
            ? full.text.split('\n').map((line, i) => (
                <div key={i} className="code-line">
                  <span className="ln">{i + 1}</span>
                  <span className="ct">
                    {highlight(line, full.lang).map((tok, j) => (
                      <span key={j} className={tok.cls ?? undefined}>
                        {tok.text}
                      </span>
                    ))}
                  </span>
                </div>
              ))
            : null}
      </div>
      )}
    </div>
  )
}
