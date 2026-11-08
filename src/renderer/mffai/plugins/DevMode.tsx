// 开发插件(08 §13.5,09 §12):进程内的 JS 什么都能做,所以这一组常驻红色 完全访问,不是一个普通开关。
// 选目录 → 信任 → 确认框,要逐字输入目录名才放开按钮;发出去的是 acknowledge:'runs_with_full_access'。
// 结果显示 id、hash、bytes、main(用户要看得到批的是哪一份)和 重启后台。移除之后同样要重启。
// status.problems 含 dev_crashed → 组头 已跳过;再信任或移除任何一个都清掉它。
import { useRef, useState } from 'react'
import type { PluginListResult, WorkerResult } from '@mffai/protocol'
import { call } from '../rpc'
import { Chip } from '../ui/Chip'
import { Confirm } from '../ui/Confirm'
import { PathField } from '../ui/PathField'
import { PText } from '../ui/PText'
import { FailChip, useAction } from './action'

type Dev = PluginListResult['dev'][number]
type TrustResult = WorkerResult<'plugins.dev.trust'>

export const ACKNOWLEDGE = 'runs_with_full_access' as const

/** 路径的最后一段(去掉结尾的分隔符),确认框要逐字输入的就是它 */
export function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '')
  return parts.at(-1) ?? ''
}

function RestartButton() {
  const inflight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const restart = async () => {
    if (inflight.current) return
    inflight.current = true
    setBusy(true)
    setFailed(false)
    try {
      await window.forge.mffai.restart()
    } catch (e) {
      console.error('mffai restart', e)
      setFailed(true)
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <button className="set-btn mffai-primary" disabled={busy} onClick={() => void restart()}>重启后台</button>
      {failed && <span className="mffai-fail">失败</span>}
    </>
  )
}

function DevRow({ d, onRemoved }: { d: Dev; onRemoved: () => void }) {
  const { run, busy, failure } = useAction()
  const remove = () => void run('plugins.dev.remove', async () => {
    await call('plugins.dev.remove', { id: d.id })
    onRemoved()
  })
  return (
    <div className="mffai-row mffai-crow" data-dev={d.id}>
      <PText text={d.id} mono />
      <span className="mffai-k">hash</span>
      <PText text={d.hash} mono />
      <time dateTime={new Date(d.trustedAt).toISOString()}>{new Date(d.trustedAt).toLocaleString()}</time>
      <button className="set-btn" disabled={busy} onClick={remove}>移除</button>
      <FailChip failure={failure} />
    </div>
  )
}

export function DevMode({ dev, problems, onChanged }: { dev: readonly Dev[]; problems: readonly string[]; onChanged: () => void }) {
  const [path, setPath] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [result, setResult] = useState<TrustResult | null>(null)
  const [needsRestart, setNeedsRestart] = useState(false)
  const { run, busy, failure, setFailure, alive } = useAction()

  const trust = (p: string) => void run('plugins.dev.trust', async () => {
    const r = await call('plugins.dev.trust', { path: p, acknowledge: ACKNOWLEDGE })
    if (!alive.current) return
    setResult(r)
    setConfirming(null)
    setNeedsRestart(r.restartRequired)
    onChanged()
  })

  return (
    <div className="mffai-group" data-section="dev">
      <div className="mffai-grouphead">
        <span>开发插件</span>
        <span className="mffai-row">
          <Chip tone="bad">完全访问</Chip>
          {problems.includes('dev_crashed') && <Chip tone="warn">已跳过</Chip>}
        </span>
      </div>
      {dev.map((d) => <DevRow key={d.id} d={d} onRemoved={() => { setNeedsRestart(true); onChanged() }} />)}
      <div className="mffai-row">
        <PathField kind="directory" label="开发插件目录" value={path} onChange={setPath} />
        <button className="set-btn" disabled={!basename(path.trim())} onClick={() => { setFailure(null); setConfirming(path.trim()) }}>信任</button>
      </div>
      {result && (
        <div className="mffai-row mffai-crow" data-dev-result>
          <span className="mffai-k">id</span><PText text={result.id} mono />
          <span className="mffai-k">hash</span><PText text={result.hash} mono />
          <span className="mffai-k">bytes</span><span className="mffai-count">{result.bytes}</span>
          <span className="mffai-k">main</span><PText text={result.main} mono />
        </div>
      )}
      {needsRestart && <div className="mffai-actions"><RestartButton /></div>}
      {confirming !== null && (
        <Confirm title="以完全访问权限运行" rows={[['目录', <PText key="p" text={confirming} mono />], ['目录名', <PText key="n" text={basename(confirming)} mono />]]}
          requireTyped={basename(confirming)} typedLabel="输入目录名" confirmLabel="以完全访问权限运行" danger busy={busy}
          onCancel={() => setConfirming(null)} onConfirm={() => trust(confirming)}>
          <FailChip failure={failure} />
        </Confirm>
      )}
    </div>
  )
}
