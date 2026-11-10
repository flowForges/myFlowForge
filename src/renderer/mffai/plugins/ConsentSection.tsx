// 同意页的一节(08b spec R10、R11):头(图标、标题、数目、我们的块、变更块)+ 内容。永远展开:
// 同意页完整性要求每个值都在页面上,折叠等于没给人看。首装页 A 和升级弹窗 B 共用。
import type { ReactNode } from 'react'
import type { PluginDiff } from '@mffai/protocol'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../shell/icons'

export type Marks = { add?: number; mod?: number; del?: number; same?: boolean }
export type DiffSec = 'mcp' | 'network' | 'notRun' | 'skills' | 'config' | 'claimed'

const marksOf = (add: number, mod: number, del: number): Marks => {
  if (!add && !mod && !del) return { same: true }
  return { ...(add > 0 && { add }), ...(mod > 0 && { mod }), ...(del > 0 && { del }) }
}

/** 每一节的变更数,只看 diff 的字段。新加的必填敏感配置是新增配置的一部分,只算一次 */
export function diffMarks(d: PluginDiff): Record<DiffSec, Marks> {
  return {
    mcp: marksOf(d.mcp.added.length, d.mcp.changed.length, d.mcp.removed.length),
    network: marksOf(d.network.added.length, 0, d.network.removed.length),
    notRun: marksOf(d.notRun.hooksAdded.length + d.notRun.added.length, 0, d.notRun.hooksRemoved.length),
    skills: marksOf(
      d.skills.added.length + d.commands.added.length,
      d.skills.textChanged.length + d.commands.textChanged.length,
      d.skills.removed.length + d.commands.removed.length,
    ),
    config: marksOf(new Set([...d.config.added, ...d.config.requiredSensitive]).size, 0, 0),
    claimed: { same: true },
  }
}

export function MarkChips({ marks }: { marks: Marks }) {
  return (
    <span className="mffai-cmark">
      {marks.add ? <Chip tone="ok" sq>{`新增 ${marks.add}`}</Chip> : null}
      {marks.mod ? <Chip tone="warn" sq>{`改动 ${marks.mod}`}</Chip> : null}
      {marks.del ? <Chip tone="bad" sq>{`删除 ${marks.del}`}</Chip> : null}
      {marks.same && <Chip tone="line" sq>未变</Chip>}
    </span>
  )
}

export function ConsentSection({ name, icon, title, count, marks, chip, children }: {
  name: string
  icon: IconName
  title: string
  count?: string
  marks?: Marks
  /** 我们的块(未验证、来源已变),跟在标题后面 */
  chip?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="mffai-cs" data-section={name}>
      <div className="mffai-cs-h">
        <Icon name={icon} size={14} />
        <span className="mffai-cs-t">{title}</span>
        {count !== undefined && <span className="mffai-count">{count}</span>}
        <span className="mffai-head-spring" />
        {chip}
        {marks && <MarkChips marks={marks} />}
      </div>
      <div className="mffai-cs-b">{children}</div>
    </section>
  )
}
