export interface AgentEnvOpts { proxy: string; timezone?: string; overrides?: Record<string, string> }

export function buildAgentEnv(opts: AgentEnvOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const p = opts.proxy?.trim()
  if (p) {
    env.HTTP_PROXY = p; env.HTTPS_PROXY = p; env.ALL_PROXY = p
    env.http_proxy = p; env.https_proxy = p; env.all_proxy = p
    const existingNoProxy = env.NO_PROXY || env.no_proxy || ''
    const noProxy = existingNoProxy ? `${existingNoProxy},localhost,127.0.0.1` : 'localhost,127.0.0.1'
    env.NO_PROXY = noProxy; env.no_proxy = noProxy
  } else {
    // "留空则直连" must be literal. The app inherits its whole launch environment (env.ts:4), which
    // on some setups already carries an HTTP(S)_PROXY the user can neither see nor clear from the 终端代理
    // pane. Leaving those untouched silently routes the provider through a stale/wrong proxy — exactly the
    // 403 footgun (an empty box read as "direct" while claude was actually going out through an inherited
    // proxy). So an empty setting strips them and forces a genuine direct connection.
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k]
  }
  // Per-provider timezone → env.TZ (libc/Node/Python all honor it). Empty = leave the inherited system
  // TZ untouched, so providers without a configured timezone behave exactly as before.
  const tz = opts.timezone?.trim()
  if (tz) env.TZ = tz
  if (opts.overrides) for (const [k, v] of Object.entries(opts.overrides)) env[k] = v
  return env
}
