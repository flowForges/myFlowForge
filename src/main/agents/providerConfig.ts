import { readAgentsConfig } from '../config/store'

/**
 * The per-provider timezone (IANA name) the user configured in 设置 → 编码代理, or undefined if none.
 * Fed into buildAgentEnv({ timezone }) at spawn so the provider's clock matches the chosen region.
 * Kept as a tiny standalone read so every spawn site (chat, delegate) shares one lookup instead of
 * re-implementing the agents.json read.
 */
export function providerTimezone(providerId: string): string | undefined {
  // Defensive: a timezone lookup is a nicety and must NEVER abort a spawn. Any config-read failure
  // falls back to "no timezone" (follow system) rather than throwing into the chat/delegate turn.
  try {
    const tz = readAgentsConfig().providers.find(p => p.id === providerId)?.timezone?.trim()
    return tz || undefined
  } catch {
    return undefined
  }
}
