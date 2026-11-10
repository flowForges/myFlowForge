import type { FileDiff } from '@mffai/protocol'
import { Chip } from './Chip'
import { Icon } from '../shell/icons'
import '../../views/inspector/inspector.css'

/** 后台算好的逐文件 diff,用检查器的 .code-line 样式。08b:头上一行 +n −n(从这些行数出来)和 二进制 / 已截断 */
export function DiffLines({ diff }: { diff: FileDiff }) {
  const add = diff.lines.filter((l) => l.kind === 'add').length
  const del = diff.lines.filter((l) => l.kind === 'del').length
  return (
    <div className="mffai-diff">
      <div className="mffai-diff-flags">
        <Icon name="file" size={12} />
        <span className="mffai-dstat"><span className="a">{`+${add}`}</span> <span className="d">{`−${del}`}</span></span>
        {diff.binary && <Chip>二进制</Chip>}
        {diff.truncated && <Chip>已截断</Chip>}
      </div>
      {diff.lines.map((l, i) => (
        <div key={i} className={l.kind === 'ctx' ? 'code-line' : `code-line ${l.kind}`}>
          <span className="ln">{l.ln}</span>
          <span className="ct">{l.text}</span>
        </div>
      ))}
    </div>
  )
}
