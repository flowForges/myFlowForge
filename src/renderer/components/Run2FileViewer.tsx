import { useEffect, useState } from 'react'
import { Markdown } from '../views/chat/markdown'

// P5-UI Task 2: modal file viewer opened from RunPanel's "改动文件" (filesChanged) list — lets the
// user actually SEE what a work order changed, instead of just a bare path string. Read-only,
// additive, run2-only.

type ReadResult = { content: string; truncated?: boolean } | { error: string }

interface Run2FileViewerProps {
  path: string
  cwd?: string
  onClose: () => void
}

const MD_RE = /\.(md|markdown)$/i

function getRun2(): any {
  return typeof window !== 'undefined' ? (window as any).forge?.run2 : undefined
}

export function Run2FileViewer({ path, cwd, onClose }: Run2FileViewerProps) {
  const [result, setResult] = useState<ReadResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setResult(null)
    const run2 = getRun2()
    if (!run2?.readFile) {
      setResult({ error: '文件读取功能不可用' })
      setLoading(false)
      return
    }
    run2.readFile({ path, cwd })
      .then((r: ReadResult) => { if (alive) setResult(r) })
      .catch((err: unknown) => { if (alive) setResult({ error: String(err) }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [path, cwd])

  const isMd = MD_RE.test(path)

  return (
    <div className="run2-file-viewer-overlay" onClick={onClose}>
      <div className="run2-file-viewer" onClick={(e) => e.stopPropagation()}>
        <div className="run2-file-viewer-head">
          <span className="run2-file-viewer-path" title={path}>{path}</span>
          <button className="txt-btn run2-file-viewer-close" onClick={onClose} aria-label="关闭">关闭</button>
        </div>
        <div className="run2-file-viewer-body">
          {loading && <div className="run2-file-viewer-loading">加载中…</div>}
          {!loading && result && 'error' in result && (
            <div className="run2-file-viewer-error">{result.error}</div>
          )}
          {!loading && result && 'content' in result && (
            <>
              {result.truncated && (
                <div className="run2-file-viewer-truncated">文件过大，已截断显示前 512KB</div>
              )}
              {isMd
                ? <Markdown text={result.content} />
                : <pre className="run2-file-viewer-pre"><code>{result.content}</code></pre>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
