// 档案的一个文件编辑器(08 §12.1):USER.md、MEMORY.md 或某个主题文件,都用这一个组件。
// 哈希对不上(写的时候后台已经变了,ERR_BUSY 'file changed')→ 已在别处修改 · 重新载入,不自动覆盖脏稿。
// 超限(ERR_INVALID 'full')→ 已满,留着稿子让用户自己删。远端 memory.updated 针对这份文件:干净就默默重取,
// 脏着就只显示冲突按钮,不盖掉正在编辑的文字(和 Permissions 页同一条规矩)。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryFile } from '@mffai/protocol'
import { call, isUnsupported, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { Chip } from '../ui/Chip'

const ERR_BUSY = -32003
const ERR_INVALID = -32602
const K = '\u0000'

export function FileEditor({ file }: { file: MemoryFile }) {
  const [content, setContent] = useState('')
  const [cap, setCap] = useState(0)
  const [masked, setMasked] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'unsupported' | 'failed' | 'full' | null>(null)

  const hashRef = useRef('')
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const inflight = useRef(false)
  const retry = useRef(retryable()).current
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(() => {
    void call('memory.file.get', { file }).then(
      (r) => {
        if (!alive.current) return
        setContent(r.content)
        setCap(r.cap)
        hashRef.current = r.hash
        setDirty(false)
        setConflict(false)
        setStatus(null)
      },
      (e) => {
        if (!alive.current) return
        setStatus(isUnsupported(e) ? 'unsupported' : 'failed')
      },
    )
  }, [file])
  useEffect(load, [load])

  useMffaiEvent({ types: ['memory.updated'] }, (e) => {
    const p = e.payload as { file?: string }
    if (p.file !== file) return
    if (dirtyRef.current) { setConflict(true); return }
    load()
  })
  useMffaiReset(() => {
    if (dirtyRef.current) { setConflict(true); return }
    load()
  })

  const edit = (v: string) => { setContent(v); setDirty(true); setStatus(null) }

  const save = async () => {
    if (inflight.current) return
    const key = file + K + hashRef.current + K + content
    inflight.current = true
    setBusy(true)
    setStatus(null)
    try {
      const r = await call('memory.file.set', { commandId: retry.id(key), file, content, expectedHash: hashRef.current })
      retry.done(key)
      if (!alive.current) return
      hashRef.current = r.hash
      setMasked(r.masked)
      setDirty(false)
    } catch (e) {
      const c = toCallError(e)
      if (!alive.current) return
      if (c.code === ERR_BUSY) setConflict(true)
      else if (c.code === ERR_INVALID && c.message === 'full') setStatus('full')
      else if (isUnsupported(c)) setStatus('unsupported')
      else { console.error('mffai memory.file.set', c); setStatus('failed') }
    } finally {
      inflight.current = false
      if (alive.current) setBusy(false)
    }
  }

  const used = [...content].length

  return (
    <div className="mffai-card mffai-fileeditor" data-testid={`mffai-file-${file}`}>
      <div className="mffai-row">
        <span className="mffai-k">{file}</span>
        <span className="mffai-count">{`${used} / ${cap}`}</span>
        {masked > 0 && <Chip tone="warn">{`已打码 ${masked}`}</Chip>}
      </div>
      <textarea
        aria-label={file}
        className="mffai-input mffai-filebody"
        value={content}
        disabled={busy}
        onChange={(e) => edit(e.target.value)}
      />
      <div className="mffai-actions">
        {conflict ? (
          <button className="set-btn" onClick={load}>已在别处修改 · 重新载入</button>
        ) : (
          <button className="set-btn mffai-primary" disabled={!dirty || busy} onClick={() => void save()}>保存</button>
        )}
        {status === 'unsupported' && <Chip tone="bad">不支持</Chip>}
        {status === 'failed' && <span className="mffai-fail">失败</span>}
        {status === 'full' && <Chip tone="bad">已满</Chip>}
      </div>
    </div>
  )
}
