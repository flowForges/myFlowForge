// 改动清单 + 逐文件 diff(08 §8.4、§8.5)。清单来自后台(turn.changes / executor.changes),diff 只能点清单里的那几项;
// source 为 cli 时只有路径、没有 diff。diff 用后台算好的 DiffLines。
import { useEffect, useRef, useState } from 'react'
import type { ExecutorChangesSource, FileChange, FileDiff } from '@mffai/protocol'
import { isUnsupported, toCallError } from '../rpc'
import { Chip } from '../ui/Chip'
import { DiffLines } from '../ui/DiffLines'

export interface ChangeList { files: FileChange[]; source?: ExecutorChangesSource; concurrent?: boolean }

type Load = { state: 'loading' } | { state: 'ok'; list: ChangeList } | { state: 'unsupported' } | { state: 'failed' }
type Shown = { path: string; diff?: FileDiff; failed?: boolean }

export function ChangesBlock({ load, diff }: { load: () => Promise<ChangeList>; diff: (path: string) => Promise<FileDiff> }) {
  const [list, setList] = useState<Load>({ state: 'loading' })
  const [shown, setShown] = useState<Shown | null>(null)
  const alive = useRef(true)
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    alive.current = true
    void loadRef.current().then(
      (l) => { if (alive.current) setList({ state: 'ok', list: l }) },
      (e) => {
        if (!alive.current) return
        const c = toCallError(e)
        if (!isUnsupported(c)) console.error('mffai changes', c)
        setList({ state: isUnsupported(c) ? 'unsupported' : 'failed' })
      },
    )
    return () => { alive.current = false }
  }, [])

  const open = (path: string) => {
    if (shown?.path === path) { setShown(null); return }
    setShown({ path })
    void diff(path).then(
      (d) => { if (alive.current) setShown((s) => (s?.path === path ? { path, diff: d } : s)) },
      (e) => {
        console.error('mffai diff', toCallError(e))
        if (alive.current) setShown((s) => (s?.path === path ? { path, failed: true } : s))
      },
    )
  }

  if (list.state === 'loading') return <div className="mffai-changes" />
  if (list.state === 'unsupported') return <div className="mffai-changes"><Chip>不支持</Chip></div>
  if (list.state === 'failed') return <div className="mffai-changes"><span className="mffai-fail">失败</span></div>
  const { files, source, concurrent } = list.list
  const paths = source === 'cli'
  return (
    <div className="mffai-changes">
      {concurrent && <Chip tone="warn">同时有其他改动</Chip>}
      <ul className="mffai-files">
        {files.map((f) => (
          <li key={f.path} className={`mffai-file${shown?.path === f.path ? ' on' : ''}`}>
            {paths ? (
              <><span className={`mffai-st st-${f.status}`}>{f.status}</span><span className="mffai-path">{f.path}</span></>
            ) : (
              <button className="mffai-file-btn" aria-expanded={shown?.path === f.path} onClick={() => open(f.path)}>
                <span className={`mffai-st st-${f.status}`}>{f.status}</span><span className="mffai-path">{f.path}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {shown?.diff && <DiffLines diff={shown.diff} />}
      {shown?.failed && <span className="mffai-fail">失败</span>}
    </div>
  )
}
