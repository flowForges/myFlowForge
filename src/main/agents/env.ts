export interface AgentEnvOpts { proxy: string; overrides?: Record<string, string> }

export function buildAgentEnv(opts: AgentEnvOpts): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const p = opts.proxy?.trim()
  if (p) {
    env.HTTP_PROXY = p; env.HTTPS_PROXY = p; env.ALL_PROXY = p
    env.http_proxy = p; env.https_proxy = p; env.all_proxy = p
    const existingNoProxy = env.NO_PROXY || env.no_proxy || ''
    const noProxy = existingNoProxy ? `${existingNoProxy},localhost,127.0.0.1` : 'localhost,127.0.0.1'
    env.NO_PROXY = noProxy; env.no_proxy = noProxy
  }
  if (opts.overrides) for (const [k, v] of Object.entries(opts.overrides)) env[k] = v
  return env
}
