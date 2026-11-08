// 同意页(08 §13.2,09 §7):纯组件,只按 PluginConsent 的每个字段渲染后台给的内容,什么都不加、什么都不折叠。
// 插件写的文字一律经 PText:当文字,不当链接、标签、按钮或状态块。我们的状态块和稳定代码用 Chip / CodeChip。
// 同意时服务没跑过,所以这里不写"同意了这些工具"(09 §7)。
import type { ReactNode } from 'react'
import type { McpCwd, PluginConsent, PluginDiff } from '@mffai/protocol'
import { Chip } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { PText } from '../ui/PText'

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
        ? <Chip key={i} tone="muted">{SYMBOLS[p]}</Chip>
        : p !== '' && <PText key={i} text={p} mono />))}
    </span>
  )
}

function Row({ k, children, ...rest }: { k: string; children: ReactNode; [data: `data-${string}`]: string }) {
  return <div className="mffai-row mffai-crow" {...rest}><span className="mffai-k">{k}</span>{children}</div>
}

function Section({ name, title, children, chip }: { name: string; title: string; children: ReactNode; chip?: ReactNode }) {
  return (
    <div className="mffai-group mffai-csec" data-section={name}>
      <div className="mffai-grouphead"><span>{title}</span>{chip}</div>
      {children}
    </div>
  )
}

const Names = ({ names }: { names: readonly string[] }) => <>{names.map((n, i) => <PText key={i} text={n} mono />)}</>

function HookRow({ h, ...rest }: { h: Hook; [data: `data-${string}`]: string }) {
  return (
    <div className="mffai-row mffai-crow" {...rest}>
      <PText text={h.event} />
      {h.masked && <Chip tone="warn">已打码</Chip>}
      <pre className="mffai-pre"><PText text={h.command} mono /></pre>
    </div>
  )
}

function Server({ s }: { s: Mcp }) {
  const masked = new Set(s.argsMasked)
  return (
    <div className="mffai-cserver" data-server={s.name}>
      <div className="mffai-row">
        <PText text={s.name} mono />
        {s.problems.length > 0 && <Chip tone="bad">不会启动</Chip>}
        {s.problems.map((p, i) => <CodeChip key={i} code={p} />)}
        {s.fetchesAtRuntime && <Chip tone="warn">运行时下载</Chip>}
      </div>
      <Row k="command"><Symbolic text={s.command} /></Row>
      {s.args.length > 0 && (
        <Row k="args">
          <span className="mffai-args">
            {s.args.map((a, i) => (
              <span key={i} className="mffai-arg" data-arg={i}>
                <Symbolic text={a} />
                {masked.has(i) && <Chip tone="warn">已打码</Chip>}
              </span>
            ))}
          </span>
        </Row>
      )}
      {s.env.map((e, i) => (
        <Row key={i} k="env" data-env={String(i)}>
          <PText text={e.name} mono />
          <CodeChip code={e.source} />
          {e.required && <Chip>必填</Chip>}
          {e.value !== undefined && <Symbolic text={e.value} />}
        </Row>
      ))}
      {s.declared && (
        <>
          <Row k="声明联网"><Names names={s.declared.network} /></Row>
          <Row k="声明 cwd"><Chip>{cwdLabel(s.declared.cwd)}</Chip></Row>
        </>
      )}
    </div>
  )
}

function Diff({ d }: { d: PluginDiff }) {
  const lists: [string, readonly string[]][] = [
    ['MCP 新增', d.mcp.added], ['MCP 删除', d.mcp.removed],
    ['技能新增', d.skills.added], ['技能删除', d.skills.removed], ['技能改动', d.skills.textChanged],
    ['命令新增', d.commands.added], ['命令删除', d.commands.removed], ['命令改动', d.commands.textChanged],
    ['联网新增', d.network.added], ['联网删除', d.network.removed],
    ['配置新增', d.config.added], ['必填敏感', d.config.requiredSensitive],
    ['不运行新增', d.notRun.added],
  ]
  return (
    <Section name="diff" title="升级差异" chip={d.sourceChanged ? <Chip tone="bad">来源已变</Chip> : undefined}>
      <Row k="版本"><PText text={`${d.fromVersion} → ${d.toVersion}`} mono /></Row>
      {d.integrity && <Row k="完整性"><PText text={`${d.integrity.from} → ${d.integrity.to}`} mono /></Row>}
      <Row k="文件数"><span className="mffai-count">{`${d.files.from} → ${d.files.to}`}</span></Row>
      {lists.filter(([, xs]) => xs.length > 0).map(([k, xs]) => <Row key={k} k={k}><Names names={xs} /></Row>)}
      {d.mcp.changed.map((c, i) => (
        <Row key={`c${i}`} k="MCP 改动"><PText text={c.name} mono />{c.fields.map((f) => <CodeChip key={f} code={f} />)}</Row>
      ))}
      {d.notRun.hooksAdded.map((h, i) => <Row key={`ha${i}`} k="hook 新增"><HookRow h={h} /></Row>)}
      {d.notRun.hooksRemoved.map((h, i) => <Row key={`hr${i}`} k="hook 删除"><HookRow h={h} /></Row>)}
    </Section>
  )
}

export function Consent({ consent: c }: { consent: PluginConsent }) {
  const src = c.source
  const nr = c.notRun
  const notRunLists: [string, readonly string[]][] = [
    ['agents', nr.agents], ['bin', nr.bin], ['monitors', nr.monitors], ['workflows', nr.workflows],
    ['lsp', nr.lsp], ['other', nr.other], ['scripts', nr.scripts],
  ]
  const anyNotRun = nr.hooks.length > 0 || nr.remoteMcp.length > 0 || nr.main !== undefined || notRunLists.some(([, xs]) => xs.length > 0)
  return (
    <div className="mffai-consent">
      <div className="mffai-group mffai-csec" data-section="head">
        <div className="mffai-row">
          <PText text={c.id} mono />
          <PText text={c.version} mono />
          <CodeChip code={c.format} />
        </div>
        {src.kind === 'path'
          ? <Row k="路径"><PText text={src.path} mono /></Row>
          : (
            <>
              <Row k="地址"><PText text={src.url} mono /></Row>
              {src.ref !== undefined && <Row k="ref"><PText text={src.ref} mono /></Row>}
              <Row k="commit"><PText text={src.commit} mono /></Row>
              {src.subpath !== undefined && <Row k="子目录"><PText text={src.subpath} mono /></Row>}
            </>
          )}
        <Row k="完整性"><PText text={c.integrity} mono /></Row>
        <div className="mffai-row"><span className="mffai-count">{`文件 ${c.files} · ${c.bytes} 字节`}</span></div>
      </div>

      <Section name="claimed" title="插件自述" chip={<Chip tone="warn">自称</Chip>}>
        <Row k="名字"><PText text={c.claimed.name} /></Row>
        <Row k="描述"><PText text={c.claimed.description} /></Row>
        {c.claimed.author !== undefined && <Row k="作者"><PText text={c.claimed.author} /></Row>}
        {c.claimed.homepage !== undefined && <Row k="主页"><PText text={c.claimed.homepage} mono /></Row>}
      </Section>

      {c.skills.length > 0 && (
        <Section name="skills" title="技能">
          {c.skills.map((s, i) => (
            <div key={i} className="mffai-row mffai-crow" data-skill={i}>
              <PText text={s.name} mono />
              <PText text={s.description} />
              {s.modelInvocable && <Chip>模型可调</Chip>}
              {s.userInvocable && <Chip>用户可调</Chip>}
              <span className="mffai-count">{`文件 ${s.files}`}</span>
              {s.flags.map((f, j) => <CodeChip key={j} code={f} />)}
              {s.ignored.length > 0 && <span className="mffai-k">忽略</span>}
              <Names names={s.ignored} />
            </div>
          ))}
        </Section>
      )}

      {c.commands.length > 0 && (
        <Section name="commands" title="命令">
          {c.commands.map((s, i) => (
            <div key={i} className="mffai-row mffai-crow" data-command={i}>
              <PText text={s.name} mono />
              <PText text={s.description} />
              {s.flags.map((f, j) => <CodeChip key={j} code={f} />)}
              {s.ignored.length > 0 && <span className="mffai-k">忽略</span>}
              <Names names={s.ignored} />
            </div>
          ))}
        </Section>
      )}

      {c.mcp.length > 0 && (
        <Section name="mcp" title="MCP 服务">
          {c.mcp.map((s, i) => <Server key={i} s={s} />)}
        </Section>
      )}

      {c.config.length > 0 && (
        <Section name="config" title="配置项">
          {c.config.map((k, i) => (
            <div key={i} className="mffai-row mffai-crow" data-config={i}>
              <PText text={k.key} mono />
              <PText text={k.title} />
              {k.sensitive && <Chip tone="warn">敏感</Chip>}
              {k.required && <Chip>必填</Chip>}
              <PText text={k.type} mono />
            </div>
          ))}
        </Section>
      )}

      {anyNotRun && (
        <Section name="notrun" title="不会运行">
          {nr.hooks.map((h, i) => <HookRow key={i} h={h} data-hook={String(i)} />)}
          {notRunLists.filter(([, xs]) => xs.length > 0).map(([k, xs]) => <Row key={k} k={k}><Names names={xs} /></Row>)}
          {nr.remoteMcp.map((r, i) => (
            <Row key={`r${i}`} k="远程 MCP"><PText text={r.name} mono /><PText text={r.type} mono /><PText text={r.url} mono /></Row>
          ))}
          {nr.main !== undefined && <Row k="main"><PText text={nr.main} mono /></Row>}
        </Section>
      )}

      {c.warnings.length > 0 && (
        <Section name="warnings" title="警告">
          <div className="mffai-row">{c.warnings.map((w, i) => <CodeChip key={i} code={w} />)}</div>
        </Section>
      )}

      {c.truncatedSections.length > 0 && (
        <Section name="truncated" title="截断">
          {c.truncatedSections.map((t, i) => (
            <div key={i} className="mffai-row"><Chip tone="warn">{`${t.section} 省略 ${t.omitted} 项`}</Chip></div>
          ))}
        </Section>
      )}

      {c.diff && <Diff d={c.diff} />}
    </div>
  )
}
