// 档案的一个文件编辑器(08 §12.1):USER.md、MEMORY.md 或某个主题文件,都用这一个组件。
// 哈希对不上(写的时候后台已经变了,ERR_BUSY 'file changed')→ 已在别处修改 · 重新载入,不自动覆盖脏稿。
// 超限(ERR_INVALID 'full')→ 已满,留着稿子让用户自己删。远端 memory.updated:带这份文件的 file → 按它;
// 没带 file(删除/移除类操作,见 files.ts 的 updated() 调用点,`op:'remove'` 常常不点名文件)→ 当作可能牵连
// 任何文件,一样走干净重取 / 脏了标冲突那一条规矩。保存期间(savingRef)忽略 memory.updated:自己这次保存
// 落盘前后台先发的那条事件,不该被当成"别处改了"——保存成功后改成整份重取,拿后台打码、去空白之后存的真文本,
// 不是本地拼出来的那份。字数计数和后台的上限检查用同一个算法(去行尾来源注释、整篇 trim,files.ts:132,244),
// 不然这里显示的"已用"会比后台认的字数多,靠后台的注释算数。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryFile } from '@mffai/protocol'
import { call, retryable, toCallError } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { memoryUnsupported } from './unavailable'
import { Chip } from '../ui/Chip'

const ERR_BUSY = -32003
const ERR_INVALID = -32602
const K = '\u0000'

// 和 harness/src/plugins/memory-default/files.ts 的 trailingComment/stripComment/visible 同一套规则:
// 只有形如 `<!-- mff id=<64 字内 id> src=<src> -->` 的行尾注释才算来源标记,去掉之后整篇再 trim
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SRC_RE = /^[a-z_]{1,32}$/

function commentStart(line: string): number | undefined {
  const at = line.lastIndexOf('<!--')
  if (at < 0) return undefined
  const tail = line.slice(at).trimEnd()
  if (!tail.endsWith('-->')) return undefined
  const [tag, ...attrs] = tail.slice(4, -3).trim().split(/\s+/)
  if (tag !== 'mff') return undefined
  const kv = new Map(attrs.filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]))
  const id = kv.get('id')
  const src = kv.get('src')
  if (!id || !src || !ID_RE.test(id) || !SRC_RE.test(src)) return undefined
  return at
}

const stripComment = (line: string): string => {
  const at = commentStart(line)
  return (at === undefined ? line : line.slice(0, at)).replace(/\s+$/, '')
}

/** 后台算字数、算上限用的"可见文本":去掉行尾来源注释,整篇再 trim */
const visible = (md: string): string => md.split('\n').map(stripComment).join('\n').trim()

export function FileEditor({ file, readOnly }: { file: MemoryFile; readOnly?: boolean }) {
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
  const saving = useRef(false)
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
        setStatus(memoryUnsupported(e) ? 'unsupported' : 'failed')
      },
    )
  }, [file])
  useEffect(load, [load])

  useMffaiEvent({ types: ['memory.updated'] }, (e) => {
    if (saving.current) return // 这次保存自己产生的事件,保存还没收到回执,别当成"别处改了"
    const p = e.payload as { file?: string }
    // 没带 file 的删除/移除类操作可能牵连任何文件(files.ts updated() 不少调用点不点名文件),当成可能是这份文件
    if (p.file !== undefined && p.file !== file) return
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
    saving.current = true
    setBusy(true)
    setStatus(null)
    try {
      const r = await call('memory.file.set', { commandId: retry.id(key), file, content, expectedHash: hashRef.current })
      retry.done(key)
      if (!alive.current) return
      setMasked(r.masked)
      // 整份重取:存的文本经过打码、去空白,和本地拼出来的那份不一样,这里直接显示后台的真文本
      load()
    } catch (e) {
      const c = toCallError(e)
      if (!alive.current) return
      if (c.code === ERR_BUSY) setConflict(true)
      else if (c.code === ERR_INVALID && c.message === 'full') setStatus('full')
      else if (memoryUnsupported(c)) setStatus('unsupported')
      else { console.error('mffai memory.file.set', c); setStatus('failed') }
    } finally {
      inflight.current = false
      saving.current = false
      if (alive.current) setBusy(false)
    }
  }

  const used = [...visible(content)].length

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
        disabled={busy || readOnly}
        onChange={(e) => edit(e.target.value)}
      />
      {!readOnly && (
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
      )}
    </div>
  )
}
