// 同意页(08 §13.2,09 §7):纯组件,只按 PluginConsent 的每个字段渲染后台给的内容,什么都不加、什么都不折叠。
// 插件写的文字一律经 PText:当文字,不当链接、标签、按钮或状态块。我们的状态块和稳定代码用 Chip / CodeChip。
// 同意时服务没跑过,所以这里不写"同意了这些工具"(09 §7)。
// 08b 两种排法,子组件同一套,只换分组和外框(spec R10、R11):
//   page(首装 A):头、四块概览、两栏(左 自称 / 技能 · 命令 / 不会运行,右 MCP 服务 / 授权 / 配置项 / 警告)。
//   upgrade(升级 B):头(升级 id、旧 › 新版本、来源已变)、新旧对照、每一类一节,有变化的在前,没变的也展开,
//   标 未变 / 无新增 / 不标,看 diff 对这一类比了什么(diffMarks)。
import type { ReactNode } from 'react'
import type { McpCwd, PluginConsent, PluginDiff } from '@mffai/protocol'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PText } from '../ui/PText'
import { Icon } from '../shell/icons'
import { ConsentOverview, notRunCount, suggestedCount } from './ConsentOverview'
import { ConsentSection, diffMarks, hasChanges, type DiffSec, type Marks } from './ConsentSection'

type Mcp = PluginConsent['mcp'][number]
type Hook = PluginConsent['notRun']['hooks'][number]

export const CWD_LABEL: Record<McpCwd, string> = { none: '不给', read: '只读', write: '读写' }
const cwdLabel = (c: string) => (Object.hasOwn(CWD_LABEL, c) ? CWD_LABEL[c as McpCwd] : c)

/** 符号变量不展开,显示成块(09 M12) */
const SYMBOLS: Record<string, string> = { PLUGIN_ROOT: '插件目录', PLUGIN_DATA: '插件数据', PROJECT_DIR: '项目目录' }
const SYMBOL_RE = /\$\{(PLUGIN_ROOT|PLUGIN_DATA|PROJECT_DIR)\}/

function Symbolic({ text }: { text: string }) {
  const parts = text.split(new RegExp(SYMBOL_RE.source, 'g'))
  return (
    <span className="mffai-symbolic">
      {parts.map((p, i) => (i % 2 === 1
        ? <Chip key={i} tone="acc" sq>{SYMBOLS[p]}</Chip>
        : p !== '' && <PText key={i} text={p} mono />))}
    </span>
  )
}

function Row({ k, children, ...rest }: { k: string; children: ReactNode; [data: `data-${string}`]: string }) {
  return <div className="mffai-row mffai-crow" {...rest}><span className="mffai-k">{k}</span>{children}</div>
}

const Names = ({ names }: { names: readonly string[] }) => <>{names.map((n, i) => <PText key={i} text={n} mono />)}</>

function HookRow({ h, ...rest }: { h: Hook; [data: `data-${string}`]: string }) {
  return (
    <div className="mffai-row mffai-crow mffai-hook" {...rest}>
      <span className="mffai-k">hook</span>
      <PText text={h.event} />
      {h.masked && <Chip tone="warn" sq>已打码</Chip>}
      <pre className="mffai-pre"><PText text={h.command} mono /></pre>
    </div>
  )
}

/** 升级里的一行变化:+ 新增、− 删除、~ 改动 */
function DiffLine({ sign, children }: { sign: '+' | '−' | '~'; children: ReactNode }) {
  const tone = sign === '+' ? 'add' : sign === '−' ? 'del' : 'mod'
  return <div className={`mffai-row mffai-crow mffai-dl ${tone}`}><span className="mffai-dsign">{sign}</span>{children}</div>
}

function Server({ s }: { s: Mcp }) {
  const masked = new Set(s.argsMasked)
  return (
    <div className="mffai-cserver" data-server={s.name}>
      <div className="mffai-row mffai-csname">
        <Icon name="server" size={14} />
        <PText text={s.name} mono />
        {s.fetchesAtRuntime && <Chip tone="line" sq><Icon name="dl" size={12} />运行时下载</Chip>}
        {s.problems.length > 0 && <Chip tone="bad" sq>不会启动</Chip>}
        {s.problems.map((p, i) => <CodeChip key={i} code={p} tone="bad" />)}
      </div>
      <div className="mffai-cmdline">
        <Symbolic text={s.command} />
        {s.args.length > 0 && (
          <span className="mffai-args">
            {s.args.map((a, i) => (
              <span key={i} className="mffai-arg" data-arg={i}>
                <Symbolic text={a} />
                {masked.has(i) && <Chip tone="warn" sq><Icon name="lock" size={12} />已打码</Chip>}
              </span>
            ))}
          </span>
        )}
      </div>
      {s.env.length > 0 && (
        <div className="mffai-envtbl">
          <div className="mffai-envrow mffai-envh"><span>环境变量</span><span>来源</span><span /><span>值</span></div>
          {s.env.map((e, i) => (
            <div key={i} className="mffai-envrow" data-env={String(i)}>
              <PText text={e.name} mono />
              <span><CodeChip code={e.source} /></span>
              <span>{e.required && <Chip tone="warn" sq>必填</Chip>}</span>
              <span>{e.value !== undefined && <Symbolic text={e.value} />}</span>
            </div>
          ))}
        </div>
      )}
      {s.declared && (
        <>
          <Row k="声明联网"><Names names={s.declared.network} /></Row>
          <Row k="声明 cwd"><Chip tone="line" sq>{cwdLabel(s.declared.cwd)}</Chip></Row>
        </>
      )}
    </div>
  )
}

function SourceRows({ c }: { c: PluginConsent }) {
  const src = c.source
  if (src.kind === 'path') return <Row k="路径"><PText text={src.path} mono /></Row>
  return (
    <>
      <Row k="地址"><PText text={src.url} mono /></Row>
      {src.ref !== undefined && <Row k="ref"><PText text={src.ref} mono /></Row>}
      <Row k="commit"><PText text={src.commit} mono /></Row>
      {src.subpath !== undefined && <Row k="子目录"><PText text={src.subpath} mono /></Row>}
    </>
  )
}

const filesText = (c: PluginConsent) => `文件 ${c.files} · ${c.bytes} 字节`

/** 首装页的头:关闭、标志、id、版本、格式;来源 · integrity · 文件数大小 */
function PageHead({ c, close }: { c: PluginConsent; close?: ReactNode }) {
  const src = c.source
  return (
    <div className="mffai-chead" data-section="head">
      {close}
      <span className="mffai-plogo lg"><Icon name="puzzle" size={18} /></span>
      <div className="mffai-did">
        <div className="mffai-dname">
          <PText text={c.id} />
          <PText text={c.version} mono />
          <CodeChip code={c.format} />
        </div>
        <div className="mffai-cmeta">
          <Icon name={src.kind === 'path' ? 'folder' : 'branch'} size={12} />
          {src.kind === 'path'
            ? <PText text={src.path} mono />
            : (
              <>
                <PText text={src.url} mono />
                {src.ref !== undefined && <><span className="mffai-k">ref</span><PText text={src.ref} mono /></>}
                <span className="mffai-k">commit</span><PText text={src.commit} mono />
                {src.subpath !== undefined && <><span className="mffai-k">子目录</span><PText text={src.subpath} mono /></>}
              </>
            )}
          <span className="mffai-k">integrity</span><PText text={c.integrity} mono />
          <span className="mffai-count">{filesText(c)}</span>
        </div>
      </div>
    </div>
  )
}

function Claimed({ c, marks }: { c: PluginConsent; marks?: Marks }) {
  return (
    <ConsentSection name="claimed" icon="user" title="自称" marks={marks} chip={<Chip tone="line" sq>未验证</Chip>}>
      <div className="mffai-cclaim">
        <Row k="名字"><PText text={c.claimed.name} /></Row>
        {c.claimed.author !== undefined && <Row k="作者"><PText text={c.claimed.author} /></Row>}
        {c.claimed.homepage !== undefined && <Row k="主页"><PText text={c.claimed.homepage} mono /></Row>}
        <Row k="描述"><PText text={c.claimed.description} /></Row>
      </div>
    </ConsentSection>
  )
}

function SkillsAndCommands({ c }: { c: PluginConsent }) {
  return (
    <>
      {c.skills.length > 0 && (
        <div className="mffai-csub" data-section="skills">
          {c.skills.map((s, i) => (
            <div key={i} className="mffai-row mffai-crow" data-skill={i}>
              <PText text={s.name} mono />
              <PText text={s.description} />
              {s.modelInvocable && <Chip tone="line" sq>模型可调</Chip>}
              {s.userInvocable && <Chip tone="line" sq>用户可调</Chip>}
              <span className="mffai-count">{`文件 ${s.files}`}</span>
              {s.flags.map((f, j) => <CodeChip key={j} code={f} tone="warn" />)}
              {s.ignored.length > 0 && <span className="mffai-k">忽略</span>}
              <Names names={s.ignored} />
            </div>
          ))}
        </div>
      )}
      {c.commands.length > 0 && (
        <div className="mffai-csub" data-section="commands">
          {c.commands.map((s, i) => (
            <div key={i} className="mffai-row mffai-crow" data-command={i}>
              <PText text={s.name} mono />
              <PText text={s.description} />
              {s.flags.map((f, j) => <CodeChip key={j} code={f} tone="warn" />)}
              {s.ignored.length > 0 && <span className="mffai-k">忽略</span>}
              <Names names={s.ignored} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function ConfigRows({ c }: { c: PluginConsent }) {
  return (
    <>
      {c.config.map((k, i) => (
        <div key={i} className="mffai-row mffai-crow" data-config={i}>
          <PText text={k.key} mono />
          <PText text={k.title} />
          {k.sensitive && <Chip tone="warn" sq>敏感</Chip>}
          {k.required && <Chip sq>必填</Chip>}
          <PText text={k.type} mono />
        </div>
      ))}
    </>
  )
}

function NotRunRows({ c }: { c: PluginConsent }) {
  const nr = c.notRun
  const lists: [string, readonly string[]][] = [
    ['agents', nr.agents], ['bin', nr.bin], ['monitors', nr.monitors], ['workflows', nr.workflows],
    ['lsp', nr.lsp], ['other', nr.other], ['scripts', nr.scripts],
  ]
  return (
    <>
      {nr.hooks.map((h, i) => <HookRow key={i} h={h} data-hook={String(i)} />)}
      {lists.filter(([, xs]) => xs.length > 0).map(([k, xs]) => <Row key={k} k={k}><Names names={xs} /></Row>)}
      {nr.remoteMcp.map((r, i) => (
        <Row key={`r${i}`} k="远程 MCP"><PText text={r.name} mono /><PText text={r.type} mono /><PText text={r.url} mono /></Row>
      ))}
      {nr.main !== undefined && <Row k="main"><PText text={nr.main} mono /></Row>}
    </>
  )
}

const Warnings = ({ c }: { c: PluginConsent }) => <>{c.warnings.map((w, i) => <CodeChip key={i} code={w} tone="warn" />)}</>
const Truncated = ({ c }: { c: PluginConsent }) => (
  <span className="mffai-ctrunc" data-section="truncated">
    {c.truncatedSections.map((t, i) => <Chip key={i} tone="line" sq>{`${t.section} 省略 ${t.omitted} 项`}</Chip>)}
  </span>
)

/** 首装页里万一带了 diff(后台给什么就显示什么):原样一节 */
function PageDiff({ d }: { d: PluginDiff }) {
  const lists: [string, readonly string[]][] = [
    ['MCP 新增', d.mcp.added], ['MCP 删除', d.mcp.removed],
    ['技能新增', d.skills.added], ['技能删除', d.skills.removed], ['技能改动', d.skills.textChanged],
    ['命令新增', d.commands.added], ['命令删除', d.commands.removed], ['命令改动', d.commands.textChanged],
    ['联网新增', d.network.added], ['联网删除', d.network.removed],
    ['配置新增', d.config.added], ['必填敏感', d.config.requiredSensitive],
    ['不运行新增', d.notRun.added],
  ]
  return (
    <ConsentSection name="diff" icon="up" title="升级差异" chip={d.sourceChanged ? <Chip tone="bad" sq>来源已变</Chip> : undefined}>
      <Row k="版本"><PText text={`${d.fromVersion} → ${d.toVersion}`} mono /></Row>
      {d.integrity && <Row k="完整性"><PText text={`${d.integrity.from} → ${d.integrity.to}`} mono /></Row>}
      <Row k="文件数"><span className="mffai-count">{`${d.files.from} → ${d.files.to}`}</span></Row>
      {lists.filter(([, xs]) => xs.length > 0).map(([k, xs]) => <Row key={k} k={k}><Names names={xs} /></Row>)}
      {d.mcp.changed.map((c, i) => (
        <Row key={`c${i}`} k="MCP 改动"><PText text={c.name} mono />{c.fields.map((f) => <CodeChip key={f} code={f} />)}</Row>
      ))}
      {d.notRun.hooksAdded.map((h, i) => <Row key={`ha${i}`} k="hook 新增"><HookRow h={h} /></Row>)}
      {d.notRun.hooksRemoved.map((h, i) => <Row key={`hr${i}`} k="hook 删除"><HookRow h={h} /></Row>)}
    </ConsentSection>
  )
}

function PageLayout({ c, close, grants, checkedHosts }: { c: PluginConsent; close?: ReactNode; grants?: ReactNode; checkedHosts: number }) {
  const anyNotRun = notRunCount(c) > 0
  const skillN = c.skills.length + c.commands.length
  return (
    <div className="mffai-consent mffai-ca">
      <PageHead c={c} close={close} />
      <ConsentOverview consent={c} checkedHosts={checkedHosts} />
      <div className="mffai-ccols">
        <div className="mffai-ccol">
          <Claimed c={c} />
          {skillN > 0 && (
            <ConsentSection name="skillcmd" icon="chat" title="技能 · 命令" count={String(skillN)}>
              <SkillsAndCommands c={c} />
            </ConsentSection>
          )}
          {anyNotRun && (
            <ConsentSection name="notrun" icon="ban" title="不会运行" count={String(notRunCount(c))}>
              <NotRunRows c={c} />
            </ConsentSection>
          )}
          {c.diff && <PageDiff d={c.diff} />}
        </div>
        <div className="mffai-ccol">
          {c.mcp.length > 0 && (
            <ConsentSection name="mcp" icon="server" title="MCP 服务" count={String(c.mcp.length)}>
              {c.mcp.map((s, i) => <Server key={i} s={s} />)}
            </ConsentSection>
          )}
          {grants}
          {c.config.length > 0 && (
            <ConsentSection name="config" icon="key" title="配置项" count={String(c.config.length)}>
              <ConfigRows c={c} />
            </ConsentSection>
          )}
          {(c.warnings.length > 0 || c.truncatedSections.length > 0) && (
            <ConsentSection name="warnings" icon="alert" title="警告" count={String(c.warnings.length)}>
              <div className="mffai-row mffai-crow"><Warnings c={c} /><Truncated c={c} /></div>
            </ConsentSection>
          )}
        </div>
      </div>
    </div>
  )
}

/** 新旧对照的一行:旧 → 新。→ 两边带空格,整行读出来是「旧 → 新」 */
function Pair({ k, from, to }: { k: string; from: ReactNode; to: ReactNode }) {
  return <div className="mffai-urow"><span className="mffai-k">{k}</span><span className="mffai-uold">{from}</span><span className="mffai-uarrow"> → </span><span className="mffai-unew">{to}</span></div>
}
function Single({ k, children, ...rest }: { k: string; children: ReactNode; [data: `data-${string}`]: string }) {
  return <div className="mffai-urow" {...rest}><span className="mffai-k">{k}</span><span className="mffai-uone">{children}</span></div>
}

function UpgradeHead({ c, d, close }: { c: PluginConsent; d?: PluginDiff; close?: ReactNode }) {
  return (
    <div className="mffai-uhead" data-section="head">
      <span className="mffai-plogo lg"><Icon name="puzzle" size={18} /></span>
      <div className="mffai-did">
        <div className="mffai-dname"><span className="mffai-utitle">升级</span><PText text={c.id} /><CodeChip code={c.format} /></div>
        <div className="mffai-uver">
          {d && <><PText text={d.fromVersion} mono /><Icon name="chevr" size={12} /><PText text={d.toVersion} mono /></>}
          {(!d || d.toVersion !== c.version) && <PText text={c.version} mono />}
          {d?.sourceChanged && <Chip tone="warn" sq><Icon name="alert" size={12} />来源已变</Chip>}
        </div>
      </div>
      {close}
    </div>
  )
}

const ORDER: DiffSec[] = ['mcp', 'network', 'notRun', 'skills', 'config', 'claimed']

function UpgradeLayout({ c, close, grants }: { c: PluginConsent; close?: ReactNode; grants?: ReactNode }) {
  const d = c.diff
  const marks = d ? diffMarks(d) : null
  const src = c.source
  const reqSens = new Set(d?.config.requiredSensitive ?? [])
  const cfgNew = d ? [...new Set([...d.config.added, ...d.config.requiredSensitive])] : []
  const mcpFrom = d ? c.mcp.length - d.mcp.added.length + d.mcp.removed.length : c.mcp.length
  const body: Record<DiffSec, ReactNode> = {
    mcp: (
      <ConsentSection key="mcp" name="mcp" icon="server" title="MCP 服务" count={d ? `${mcpFrom} → ${c.mcp.length}` : String(c.mcp.length)} marks={marks?.mcp}>
        {d?.mcp.changed.map((x, i) => <DiffLine key={`c${i}`} sign="~"><PText text={x.name} mono />{x.fields.map((f) => <CodeChip key={f} code={f} tone="warn" />)}</DiffLine>)}
        {d?.mcp.added.map((n, i) => <DiffLine key={`a${i}`} sign="+"><PText text={n} mono /></DiffLine>)}
        {d?.mcp.removed.map((n, i) => <DiffLine key={`r${i}`} sign="−"><PText text={n} mono /></DiffLine>)}
        {c.mcp.map((s, i) => <Server key={i} s={s} />)}
      </ConsentSection>
    ),
    network: (
      <ConsentSection key="network" name="network" icon="globe" title="建议联网地址" count={String(suggestedCount(c))} marks={marks?.network}>
        {d?.network.added.map((n, i) => <DiffLine key={`a${i}`} sign="+"><PText text={n} mono /></DiffLine>)}
        {d?.network.removed.map((n, i) => <DiffLine key={`r${i}`} sign="−"><PText text={n} mono /></DiffLine>)}
        {grants}
      </ConsentSection>
    ),
    notRun: (
      <ConsentSection key="notrun" name="notrun" icon="ban" title="不会运行" count={String(notRunCount(c))} marks={marks?.notRun}>
        {d?.notRun.hooksAdded.map((h, i) => <DiffLine key={`ha${i}`} sign="+"><HookRow h={h} /></DiffLine>)}
        {d?.notRun.added.map((n, i) => <DiffLine key={`a${i}`} sign="+"><PText text={n} mono /></DiffLine>)}
        {d?.notRun.hooksRemoved.map((h, i) => <DiffLine key={`hr${i}`} sign="−"><HookRow h={h} /></DiffLine>)}
        <NotRunRows c={c} />
      </ConsentSection>
    ),
    skills: (
      <ConsentSection key="skillcmd" name="skillcmd" icon="chat" title="技能 · 命令" count={String(c.skills.length + c.commands.length)} marks={marks?.skills}>
        {d && ([
          ['+', '技能', d.skills.added], ['+', '命令', d.commands.added],
          ['~', '技能', d.skills.textChanged], ['~', '命令', d.commands.textChanged],
          ['−', '技能', d.skills.removed], ['−', '命令', d.commands.removed],
        ] as const).flatMap(([sign, k, xs]) => xs.map((n, i) => (
          <DiffLine key={`${sign}${k}${i}`} sign={sign}><span className="mffai-k">{k}</span><PText text={n} mono /></DiffLine>
        )))}
        <SkillsAndCommands c={c} />
      </ConsentSection>
    ),
    config: (
      <ConsentSection key="config" name="config" icon="key" title="配置项" count={String(c.config.length)} marks={marks?.config}>
        {cfgNew.map((n, i) => (
          <DiffLine key={`a${i}`} sign="+"><PText text={n} mono />{reqSens.has(n) && <><Chip tone="warn" sq>敏感</Chip><Chip sq>必填</Chip></>}</DiffLine>
        ))}
        <ConfigRows c={c} />
      </ConsentSection>
    ),
    claimed: <Claimed key="claimed" c={c} marks={marks?.claimed} />,
  }
  const changed = (s: DiffSec) => marks !== null && hasChanges(marks[s])
  const order = [...ORDER.filter(changed), ...ORDER.filter((s) => !changed(s))]
  return (
    <div className="mffai-consent mffai-cb">
      <UpgradeHead c={c} d={d} close={close} />
      <div className="mffai-ubody">
        <div className="mffai-ugrid" data-section="diff">
          {d && <Pair k="版本" from={<PText text={d.fromVersion} mono />} to={<PText text={d.toVersion} mono />} />}
          {src.kind === 'path'
            ? <Single k="路径"><PText text={src.path} mono /></Single>
            : (
              <>
                <Single k="地址"><PText text={src.url} mono /></Single>
                {src.ref !== undefined && <Single k="ref"><PText text={src.ref} mono /></Single>}
                <Single k="commit"><PText text={src.commit} mono /></Single>
                {src.subpath !== undefined && <Single k="子目录"><PText text={src.subpath} mono /></Single>}
              </>
            )}
          {d?.integrity
            ? <Pair k="integrity" from={<PText text={d.integrity.from} mono />} to={<PText text={d.integrity.to} mono />} />
            : <Single k="integrity"><PText text={c.integrity} mono /></Single>}
          {d?.integrity && d.integrity.to !== c.integrity && <Single k="integrity"><PText text={c.integrity} mono /></Single>}
          {d
            ? <Pair k="文件" from={<span className="mffai-count">{d.files.from}</span>} to={<span className="mffai-count">{`${d.files.to} · ${c.bytes} 字节`}</span>} />
            : <Single k="文件"><span className="mffai-count">{filesText(c)}</span></Single>}
          {d && d.files.to !== c.files && <Single k="文件"><span className="mffai-count">{filesText(c)}</span></Single>}
          {c.warnings.length > 0 && <Single k="警告" data-section="warnings"><Warnings c={c} /></Single>}
          {c.truncatedSections.length > 0 && <Single k="截断"><Truncated c={c} /></Single>}
        </div>
        {order.map((s) => body[s])}
      </div>
    </div>
  )
}

export function Consent({ consent, layout = 'page', close, grants, checkedHosts = 0 }: {
  consent: PluginConsent
  /** page:首装整页(A);upgrade:升级弹窗(B) */
  layout?: 'page' | 'upgrade'
  /** 头里的关闭按钮(Staging 给;纯同意页没有按钮) */
  close?: ReactNode
  /** 授权编辑器:A 放在右栏 MCP 服务后面,B 放在 建议联网地址 一节 */
  grants?: ReactNode
  /** 授权里已经勾了的域名数(A 的概览) */
  checkedHosts?: number
}) {
  return layout === 'upgrade'
    ? <UpgradeLayout c={consent} close={close} grants={grants} />
    : <PageLayout c={consent} close={close} grants={grants} checkedHosts={checkedHosts} />
}
