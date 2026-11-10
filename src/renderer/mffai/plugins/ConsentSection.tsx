// 同意页的一节(08b spec R10、R11):头(图标、标题、数目、我们的块、变更块)+ 内容。永远展开:
// 同意页完整性要求每个值都在页面上,折叠等于没给人看。首装页 A 和升级弹窗 B 共用。
import type { ReactNode } from 'react'
import type { PluginDiff } from '@mffai/protocol'
import { Chip } from '../ui/Chip'
import { Icon, type IconName } from '../shell/icons'

/** same:diff 比过两边,确实没变(未变);noAdd:diff 只记新增,只能说没有新增(无新增);都没有:diff 不比这一类,不标 */
export type Marks = { add?: number; mod?: number; del?: number; same?: boolean; noAdd?: boolean }
export type DiffSec = 'mcp' | 'network' | 'notRun' | 'skills' | 'config' | 'claimed'

const marksOf = (add: number, mod: number, del: number, empty: Marks): Marks => {
  if (!add && !mod && !del) return empty
  return { ...(add > 0 && { add }), ...(mod > 0 && { mod }), ...(del > 0 && { del }) }
}

const SAME: Marks = { same: true }
const NO_ADD: Marks = { noAdd: true }

/**
 * 每一节的变更数,只看 diff 的字段。没有变化时说多少,照后台 diffConsent 实际比了什么(harness lib/plugins/consent.ts):
 * - MCP 服务:按名字比两边(增、删、command/args/env/declared 改动)→ 未变
 * - 技能 · 命令:名字两边比、正文按哈希比 → 未变
 * - 建议联网地址:diff 只比声明的域名,建议的域名不比 → 无新增
 * - 不会运行:hook 两边比,agents/bin/…/远程 MCP/main 只记新增 → 无新增
 * - 配置项:只记新增的键 → 无新增(新加的必填敏感是新增的一部分,只算一次)
 * - 自称:不比 → 不标
 */
export function diffMarks(d: PluginDiff): Record<DiffSec, Marks> {
  return {
    mcp: marksOf(d.mcp.added.length, d.mcp.changed.length, d.mcp.removed.length, SAME),
    network: marksOf(d.network.added.length, 0, d.network.removed.length, NO_ADD),
    notRun: marksOf(d.notRun.hooksAdded.length + d.notRun.added.length, 0, d.notRun.hooksRemoved.length, NO_ADD),
    skills: marksOf(
      d.skills.added.length + d.commands.added.length,
      d.skills.textChanged.length + d.commands.textChanged.length,
      d.skills.removed.length + d.commands.removed.length,
      SAME,
    ),
    config: marksOf(new Set([...d.config.added, ...d.config.requiredSensitive]).size, 0, 0, NO_ADD),
    claimed: {},
  }
}

/** 有增、删或改 */
export const hasChanges = (m: Marks) => Boolean(m.add || m.mod || m.del)

export function MarkChips({ marks }: { marks: Marks }) {
  return (
    <span className="mffai-cmark">
      {marks.add ? <Chip tone="ok" sq>{`新增 ${marks.add}`}</Chip> : null}
      {marks.mod ? <Chip tone="warn" sq>{`改动 ${marks.mod}`}</Chip> : null}
      {marks.del ? <Chip tone="bad" sq>{`删除 ${marks.del}`}</Chip> : null}
      {marks.same && <Chip tone="line" sq>未变</Chip>}
      {marks.noAdd && <Chip tone="line" sq>无新增</Chip>}
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
