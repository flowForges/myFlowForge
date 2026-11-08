// MCP 服务状态(08 §13.4):plugins.mcp.status(不带 sessionId)的总表,可按插件筛。
// refused → 未启动 + 代码(从没起来,因为 X);stopped 带代码 → 已退出 + 代码(跑过、死于 X);
// stopped 没代码 → 已停止(我们自己停的)。别的状态走 labels.ts,不认识的原样显示。事件到了重取。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkerResult } from '@mffai/protocol'
import { call, isUnsupported } from '../rpc'
import { useMffaiEvent, useMffaiReset } from '../events'
import { label } from '../labels'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PText } from '../ui/PText'

type Row = WorkerResult<'plugins.mcp.status'>['servers'][number]

const TONE: Record<string, ChipTone> = {
  running: 'ok', starting: 'warn', stopping: 'warn', refused: 'bad', problem: 'bad', server_failed: 'bad',
  needs_sandbox: 'bad', needs_config: 'warn', integrity_failed: 'bad', disabled: 'muted', stopped: 'muted',
}

export function McpStateCell({ state, reason }: { state: string; reason?: string }) {
  // 不认识的状态是一个稳定代码,不是我们的标签:原样放进 CodeChip
  if (state !== 'refused' && state !== 'stopped' && label('mcpState', state) === state) {
    return <><CodeChip code={state} />{reason && <CodeChip code={reason} />}</>
  }
  const [text, tone]: [string, ChipTone] =
    state === 'refused' ? ['未启动', 'bad']
      : state === 'stopped' ? (reason ? ['已退出', 'bad'] : ['已停止', 'muted'])
        : [label('mcpState', state), TONE[state] ?? 'muted']
  return <><Chip tone={tone}>{text}</Chip>{reason && <CodeChip code={reason} />}</>
}

export function McpTable({ plugin }: { plugin?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [failed, setFailed] = useState<'unsupported' | 'failed' | null>(null)
  const alive = useRef(true)
  const gen = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(() => {
    const g = ++gen.current
    void call('plugins.mcp.status', {}).then(
      (r) => { if (alive.current && g === gen.current) { setRows(r.servers); setFailed(null) } },
      (e) => { if (alive.current && g === gen.current) setFailed(isUnsupported(e) ? 'unsupported' : 'failed') },
    )
  }, [])
  useEffect(load, [load])
  useMffaiEvent({ types: ['plugins.mcp.status', 'plugins.disabled', 'plugins.uninstalled', 'plugins.upgraded'] }, load)
  useMffaiReset(load)

  if (failed === 'unsupported') return <div className="mffai-group" data-section="mcp-table"><Chip tone="bad">不支持</Chip></div>
  const shown = (rows ?? []).filter((r) => plugin === undefined || r.plugin === plugin)
  return (
    <div className="mffai-group" data-section="mcp-table">
      {failed === 'failed' && <span className="mffai-fail">失败</span>}
      {shown.length > 0 && (
        <table className="mffai-mcp">
          <thead><tr><th>插件</th><th>服务</th><th>会话</th><th>状态</th><th>pid</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.plugin}/${r.sessionId}/${r.server}`} data-mcp-row={`${r.plugin}/${r.sessionId}/${r.server}`}>
                <td><PText text={r.plugin} mono /></td>
                <td><PText text={r.server} mono /></td>
                <td><span className="mffai-path">{r.sessionId}</span></td>
                <td><McpStateCell state={r.state} reason={r.reason} /></td>
                <td><span className="mffai-count">{r.pid ?? ''}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
