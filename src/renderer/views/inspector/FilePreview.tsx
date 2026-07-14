import { useEffect, useState } from 'react'
import type { ChangeType, DiffLine, FilePreview as FilePreviewData } from '@shared/types'
import { highlight } from './highlight'
import { FileIc } from './fileIcon'
import { Markdown } from '../chat/markdown'

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

  useEffect(() => {
    if (!open || !file) return
    setMode(initialMode ?? 'diff')
    setFull(null)
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
          {imgUrl ? <img className="pv-img" src={imgUrl} alt={file} />
            : imgErr ? <div className="pv-img-msg">{imgErr}</div>
            : <div className="pv-img-msg">加载中…</div>}
        </div>
      ) : mode === 'full' && full !== null && isMarkdown(file, full.lang) ? (
        <div className="pv-md">
          <Markdown text={full.text} />
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
