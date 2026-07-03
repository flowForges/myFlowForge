import type { StatusbarUsage } from '@shared/plugins'
export type { StatusbarUsage }

export type UsageWindow = { used: number; limit: number; resetAt?: number }

export interface HttpClient {
  getJson(url: string, headers: Record<string, string>): Promise<unknown>
  postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown>
}

export interface UsageAdapter {
  provider: string
  fetchUsage(http: HttpClient): Promise<StatusbarUsage>
}
