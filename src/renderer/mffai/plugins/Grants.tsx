// 授权编辑器(08 §13.2、§13.3,09 §8.1):每个服务一块。联网:建议的和声明的域名各一个勾选框,默认不勾,
// 外加一个填别的域名的输入框;cwd:不给 / 只读 / 读写,默认只读,超过声明的选项不可选。
// 总是给出每个服务(09 的裁定:带了的服务整份替换)。name_invalid、不合 MCP_SERVER_NAME 的、原型名
// (__proto__ 等,后台整份拒绝)都不列:它们不会启动,写进去还会让整次确认失败。
import type { Grants as GrantsT, McpCwd, PluginConsent } from '@mffai/protocol'
import { MCP_SERVER_NAME } from '@mffai/protocol/browser'
import { PText } from '../ui/PText'
import { TagInput } from '../perm/TagInput'
import { CWD_LABEL } from './Consent'
import { Icon } from '../shell/icons'

type Mcp = PluginConsent['mcp'][number]
const CWDS: readonly McpCwd[] = ['none', 'read', 'write']
const RANK: Record<McpCwd, number> = { none: 0, read: 1, write: 2 }
const DEFAULT_CWD: McpCwd = 'read'

/** 后台按这几个名字整份拒绝(lib/plugins/types.ts 的 PROTO_NAMES) */
const PROTO_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const grantable = (mcp: readonly Mcp[]) =>
  mcp.filter((m) => !m.problems.includes('name_invalid') && MCP_SERVER_NAME.test(m.name) && !PROTO_NAMES.has(m.name))
const capOf = (m: Mcp): McpCwd => (m.declared ? m.declared.cwd : 'write')
const minCwd = (a: McpCwd, b: McpCwd): McpCwd => (RANK[a] <= RANK[b] ? a : b)
const own = <T,>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined)
/** 没有原型的记录:服务名是第三方的,写进去碰不到 Object.prototype */
const record = <T,>(): Record<string, T> => Object.create(null) as Record<string, T>

/** 每个服务一项:当前授权(详情页)或默认值(没网、cwd 只读,不超过声明) */
export function initialGrants(mcp: readonly Mcp[], current?: GrantsT): GrantsT {
  const servers = record<GrantsT['servers'][string]>()
  for (const m of grantable(mcp)) {
    const cur = current ? own(current.servers, m.name) : undefined
    servers[m.name] = cur ? { network: [...cur.network], cwd: cur.cwd } : { network: [], cwd: minCwd(DEFAULT_CWD, capOf(m)) }
  }
  return { servers }
}

/** 声明里的域名盖不盖得住这个授权:同名,或 `*.d` 盖住它的子域 */
const covers = (declared: readonly string[], host: string) =>
  declared.some((d) => d === host || (d.startsWith('*.') && host.endsWith(d.slice(1))))

/**
 * 升级的起点 = 当前授权 ∩ 新声明(同后台的 intersectOnUpgrade):cwd 不超过新声明,声明里没了的域名去掉;
 * 没有声明的(Claude Code 格式)手填的域名原样留着;新服务从默认开始。后台对发来的服务整份替换,
 * 所以不从这里起,一次普通的升级就会把 cwd:'none' 变回只读、把域名清空
 */
export function upgradeGrants(mcp: readonly Mcp[], current: GrantsT): GrantsT {
  const kept = record<GrantsT['servers'][string]>()
  for (const m of grantable(mcp)) {
    const cur = own(current.servers, m.name)
    if (!cur) continue
    kept[m.name] = m.declared
      ? { network: cur.network.filter((h) => covers(m.declared!.network, h)), cwd: minCwd(cur.cwd, m.declared.cwd) }
      : { network: [...cur.network], cwd: cur.cwd }
  }
  return initialGrants(mcp, { servers: kept })
}

function ServerGrants({ m, value, onChange, disabled }: {
  m: Mcp
  value: GrantsT['servers'][string]
  onChange: (v: GrantsT['servers'][string]) => void
  disabled?: boolean
}) {
  // 有声明时没有输入框:已授权的(如 *.d 盖住的子域)也列成勾选框,不会变成看不见的授权
  const options = [...new Set([...m.suggestedHosts, ...(m.declared ? [...m.declared.network, ...value.network] : [])])]
  const extras = value.network.filter((h) => !options.includes(h))
  const checked = (h: string) => value.network.includes(h)
  const toggle = (h: string, on: boolean) => {
    const picked = options.filter((o) => (o === h ? on : checked(o)))
    onChange({ ...value, network: [...picked, ...extras] })
  }
  const cap = capOf(m)
  return (
    <div className="mffai-cserver" data-grants={m.name}>
      <div className="mffai-row mffai-gname"><Icon name="server" size={13} /><PText text={m.name} mono /></div>
      <div className="mffai-row mffai-crow mffai-grow">
        <span className="mffai-gico" title="联网"><Icon name="globe" size={13} /><span className="mffai-sr">联网</span></span>
        {options.map((h) => (
          <label key={h} className="mffai-check mffai-hostchk">
            <input type="checkbox" aria-label={`${m.name} ${h}`} disabled={disabled} checked={checked(h)} onChange={(e) => toggle(h, e.target.checked)} />
            <PText text={h} mono />
          </label>
        ))}
        {/* 有声明的(原生格式)只能收窄:声明以外的域名后台一律拒绝 */}
        {!m.declared && (
          <TagInput label={`其他域名 ${m.name}`} value={extras} disabled={disabled}
            onChange={(next) => onChange({ ...value, network: [...options.filter(checked), ...next] })} />
        )}
      </div>
      <div className="mffai-row mffai-crow mffai-grow">
        <span className="mffai-gico" title="cwd"><Icon name="folder" size={13} /><span className="mffai-sr">cwd</span></span>
        <span className="mffai-seg sm mffai-gseg" role="radiogroup" aria-label={`cwd ${m.name}`}>
          {CWDS.map((c) => (
            <label key={c} className="mffai-check">
              <input type="radio" name={`cwd-${m.name}`} disabled={disabled || RANK[c] > RANK[cap]} checked={value.cwd === c}
                onChange={() => onChange({ ...value, cwd: c })} />
              {CWD_LABEL[c]}
            </label>
          ))}
        </span>
        <span className="mffai-k mffai-gdir">项目目录</span>
      </div>
    </div>
  )
}

export function Grants({ mcp, value, onChange, disabled }: {
  mcp: readonly Mcp[]
  value: GrantsT
  onChange: (g: GrantsT) => void
  disabled?: boolean
}) {
  const servers = grantable(mcp)
  if (servers.length === 0) return null
  // 每次都从每个服务重建:value 里少了谁(不该发生)也补上默认值,多了的(不认识的服务)丢掉
  const full = initialGrants(servers, value)
  return (
    <div className="mffai-group mffai-csec" data-section="grants">
      <div className="mffai-grouphead"><span>授权</span></div>
      {servers.map((m) => (
        <ServerGrants key={m.name} m={m} value={full.servers[m.name]} disabled={disabled}
          onChange={(v) => onChange({ servers: Object.assign(record<GrantsT['servers'][string]>(), full.servers, { [m.name]: v }) })} />
      ))}
    </div>
  )
}
