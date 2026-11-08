import type { FileDiff } from '@mffai/protocol'
import { Chip } from './Chip'
import '../../views/inspector/inspector.css'

/** 后台算好的逐文件 diff,用检查器的 .code-line 样式 */
export function DiffLines({ diff }: { diff: FileDiff }) {
  return (
    <div className="mffai-diff">
      {(diff.binary || diff.truncated) && (
        <div className="mffai-diff-flags">
          {diff.binary && <Chip>二进制</Chip>}
          {diff.truncated && <Chip>已截断</Chip>}
        </div>
      )}
      {diff.lines.map((l, i) => (
        <div key={i} className={l.kind === 'ctx' ? 'code-line' : `code-line ${l.kind}`}>
          <span className="ln">{l.ln}</span>
          <span className="ct">{l.text}</span>
        </div>
      ))}
    </div>
  )
}
