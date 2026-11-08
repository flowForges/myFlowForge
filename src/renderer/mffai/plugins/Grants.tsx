// 授权编辑器(08 §13.2、§13.3,09 §8.1):每个服务一块。联网:建议的和声明的域名各一个勾选框,默认不勾,
// 外加一个填别的域名的输入框;cwd:不给 / 只读 / 读写,默认只读,超过声明的选项不可选。
// 总是给出每个服务(09 的裁定:带了的服务整份替换)。服务名不合 MCP_SERVER_NAME 的(name_invalid)不会启动,
// 也写不进 Grants 的 schema,所以不列。
import type { Grants as GrantsT, McpCwd, PluginConsent } from '@mffai/protocol'
import { MCP_SERVER_NAME } from '@mffai/protocol/browser'
import { PText } from '../ui/PText'
import { TagInput } from '../perm/TagInput'
import { CWD_LABEL } from './Consent'

type Mcp = PluginConsent['mcp'][number]
const CWDS: readonly McpCwd[] = ['none', 'read', 'write']
const RANK: Record<McpCwd, number> = { none: 0, read: 1, write: 2 }
const DEFAULT_CWD: McpCwd = 'read'

const grantable = (mcp: readonly Mcp[]) => mcp.filter((m) => MCP_SERVER_NAME.test(m.name))
const capOf = (m: Mcp): McpCwd => (m.declared ? m.declared.cwd : 'write')
const minCwd = (a: McpCwd, b: McpCwd): McpCwd => (RANK[a] <= RANK[b] ? a : b)
const own = <T,>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined)

/** 每个服务一项:当前授权(详情页)或默认值(没网、cwd 只读,不超过声明) */
export function initialGrants(mcp: readonly Mcp[], current?: GrantsT): GrantsT {
  const servers: GrantsT['servers'] = {}
  for (const m of grantable(mcp)) {
    const cur = current ? own(current.servers, m.name) : undefined
    servers[m.name] = cur ? { network: [...cur.network], cwd: cur.cwd } : { network: [], cwd: minCwd(DEFAULT_CWD, capOf(m)) }
  }
  return { servers }
}

function ServerGrants({ m, value, onChange, disabled }: {
  m: Mcp
  value: GrantsT['servers'][string]
  onChange: (v: GrantsT['servers'][string]) => void
  disabled?: boolean
}) {
  const options = [...new Set([...m.suggestedHosts, ...(m.declared?.network ?? [])])]
  const extras = value.network.filter((h) => !options.includes(h))
  const checked = (h: string) => value.network.includes(h)
  const toggle = (h: string, on: boolean) => {
    const picked = options.filter((o) => (o === h ? on : checked(o)))
    onChange({ ...value, network: [...picked, ...extras] })
  }
  const cap = capOf(m)
  return (
    <div className="mffai-cserver" data-grants={m.name}>
      <div className="mffai-row"><PText text={m.name} mono /></div>
      <div className="mffai-row mffai-crow">
        <span className="mffai-k">联网</span>
        {options.map((h) => (
          <label key={h} className="mffai-check">
            <input type="checkbox" aria-label={`${m.name} ${h}`} disabled={disabled} checked={checked(h)} onChange={(e) => toggle(h, e.target.checked)} />
            <PText text={h} mono />
          </label>
        ))}
        <TagInput label={`其他域名 ${m.name}`} value={extras} disabled={disabled}
          onChange={(next) => onChange({ ...value, network: [...options.filter(checked), ...next] })} />
      </div>
      <div className="mffai-row mffai-crow" role="radiogroup" aria-label={`cwd ${m.name}`}>
        <span className="mffai-k">cwd</span>
        {CWDS.map((c) => (
          <label key={c} className="mffai-check">
            <input type="radio" name={`cwd-${m.name}`} disabled={disabled || RANK[c] > RANK[cap]} checked={value.cwd === c}
              onChange={() => onChange({ ...value, cwd: c })} />
            {CWD_LABEL[c]}
          </label>
        ))}
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
          onChange={(v) => onChange({ servers: { ...full.servers, [m.name]: v } })} />
      ))}
    </div>
  )
}
