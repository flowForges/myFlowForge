import { useEffect, useRef, useState, type ReactElement } from 'react'
import { flashToast } from './flashToast'
import './importModal.css'

// Generic "batch import" sheet shared by projects / plugins / pet (1:1 with the prototype openImport).
// `parse` turns the textarea text into items (throws on invalid → Import stays disabled); `onImport`
// applies them and returns a summary string shown as a toast.
export interface ImportConfig {
  mark: 'project' | 'plugin' | 'pet'
  title: string
  desc: string
  subTitle: string
  goLabel: string
  sample: string
  placeholder: string
  drop: string
  accept?: string
  parse: (text: string) => unknown[]
  onImport: (items: unknown[]) => string
}

const MARK: Record<ImportConfig['mark'], ReactElement> = {
  project: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="18" r="2.4" /><path d="M12 8.4v2.1a3.5 3.5 0 0 1-3.5 3.5H8M12 10.5a3.5 3.5 0 0 0 3.5 3.5H16" /></svg>,
  plugin: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M14 4.5a2 2 0 1 1 4 0V6h1.5a1.5 1.5 0 0 1 1.5 1.5V9h-1.5a2 2 0 1 0 0 4H21v3.5a1.5 1.5 0 0 1-1.5 1.5H16v-1.5a2 2 0 1 0-4 0V18H8.5A1.5 1.5 0 0 1 7 16.5V13H5.5a2 2 0 1 1 0-4H7V5.5A1.5 1.5 0 0 1 8.5 4H14Z" /></svg>,
  pet: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 5c4.4 0 7 3 7 8 0 4-3 6-7 6s-7-2-7-6c0-5 2.6-8 7-8Z" /><circle cx="9.5" cy="11" r="1.1" fill="currentColor" /><circle cx="14.5" cy="11" r="1.1" fill="currentColor" /></svg>,
}

interface Props {
  config: ImportConfig | null   // null → closed
  onClose: () => void
  onFlash?: (msg: string) => void
}

export function ImportModal({ config, onClose, onFlash }: Props) {
  const [text, setText] = useState('')
  const [note, setNote] = useState<{ msg: string; cls: '' | 'ok' | 'err' }>({ msg: '', cls: '' })
  const [copied, setCopied] = useState(false)
  const [count, setCount] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Reset + focus whenever a new import opens.
  useEffect(() => {
    if (!config) return
    setText(''); setNote({ msg: '', cls: '' }); setCopied(false); setCount(0)
    const t = setTimeout(() => taRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [config])

  useEffect(() => {
    if (!config) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [config, onClose])

  if (!config) return null

  const validate = (v: string) => {
    setText(v)
    const t = v.trim()
    if (!t) { setCount(0); setNote({ msg: '', cls: '' }); return }
    try {
      const items = config.parse(t) || []
      setCount(items.length)
      setNote(items.length ? { msg: `识别到 ${items.length} 条`, cls: 'ok' } : { msg: '没有可导入的内容', cls: 'err' })
    } catch (e) {
      setCount(0)
      setNote({ msg: '格式有误:' + (e instanceof Error ? e.message : String(e)), cls: 'err' })
    }
  }

  const copySample = () => {
    navigator.clipboard?.writeText(config.sample).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1600)
    }, () => { setCopied(true); setTimeout(() => setCopied(false), 1600) })
  }
  const fillSample = () => { validate(config.sample); taRef.current?.focus() }
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return
    const r = new FileReader()
    r.onload = () => validate(String(r.result || ''))
    r.readAsText(f)
  }
  const doImport = () => {
    let items: unknown[]
    try { items = config.parse(text.trim()) || [] } catch { return }
    if (!items.length) return
    let summary: string
    try { summary = config.onImport(items) } catch (e) { setNote({ msg: '导入失败:' + (e instanceof Error ? e.message : String(e)), cls: 'err' }); return }
    onClose()
    ;(onFlash ?? flashToast)(summary)
  }

  return (
    <div className="imp-overlay on" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="imp-sheet" role="dialog" aria-modal="true">
        <div className="imp-head">
          <div className="imp-mark">{MARK[config.mark]}</div>
          <div><h2>{config.title}</h2><div className="d">{config.desc}</div></div>
          <button className="x" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        <div className="imp-body">
          <div className="imp-sub">
            <h5>{config.subTitle}</h5>
            <div className="imp-tools">
              <button className={'imp-tool' + (copied ? ' done' : '')} onClick={copySample}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
                {copied ? '已复制' : '复制示例'}
              </button>
              <button className="imp-tool" onClick={fillSample}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 5v14M5 12h14" /></svg>填入示例
              </button>
              <button className="imp-tool" onClick={() => fileRef.current?.click()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>上传文件
              </button>
              <input ref={fileRef} type="file" accept={config.accept ?? '.json,.txt,.csv'} hidden onChange={onFile} />
            </div>
          </div>
          <textarea ref={taRef} className="imp-ta" spellCheck={false} autoComplete="off"
            placeholder={config.placeholder} value={text} onChange={e => validate(e.target.value)} />
          <div className={'imp-note' + (note.cls ? ' ' + note.cls : '')}>{note.msg}</div>
        </div>
        <div className="imp-foot">
          <span className="imp-drop">{config.drop}</span>
          <button className="gh" onClick={onClose}>取消</button>
          <button className="go" disabled={count === 0} onClick={doImport}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
            <span>{config.goLabel}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
