// 账号元数据 + 运行时状态:元数据存内核配置 models 段,状态只在内存
import type { AccountConfig, ModelsConfig } from '../../kernel/config'
import type { AccountState, AccountView, ModelRef } from '../../protocol/models'

export class AccountStore {
  private cfg: ModelsConfig
  private states = new Map<string, AccountState>()

  /** persist 失败抛错:内存不变 */
  constructor(initial: ModelsConfig | undefined, private persist: (cfg: ModelsConfig) => void) {
    this.cfg = structuredClone(initial ?? { accounts: [] })
  }

  list(): AccountConfig[] {
    return this.cfg.accounts
  }

  get(id: string): AccountConfig | undefined {
    return this.cfg.accounts.find(a => a.id === id)
  }

  get default(): ModelRef | undefined {
    return this.cfg.default
  }

  private commit(next: ModelsConfig): void {
    this.persist(next)
    this.cfg = next
  }

  add(a: AccountConfig): void {
    this.commit({ ...this.cfg, accounts: [...this.cfg.accounts, a] })
    this.states.set(a.id, 'ok')
  }

  remove(id: string): void {
    const next: ModelsConfig = { accounts: this.cfg.accounts.filter(a => a.id !== id) }
    if (this.cfg.default && this.cfg.default.accountId !== id) next.default = this.cfg.default
    this.commit(next)
    this.states.delete(id)
  }

  setDefault(ref: ModelRef): void {
    this.commit({ ...this.cfg, default: { accountId: ref.accountId, modelId: ref.modelId } })
  }

  /** 适配器列出的模型清单(非密钥,随账号落盘) */
  setModels(id: string, models: AccountConfig['models']): void {
    this.commit({ ...this.cfg, accounts: this.cfg.accounts.map(a => (a.id === id ? { ...a, models } : a)) })
  }

  state(id: string): AccountState {
    return this.states.get(id) ?? 'ok'
  }

  /** 返回是否有变化 */
  setState(id: string, s: AccountState): boolean {
    if (!this.get(id) || this.state(id) === s) return false
    this.states.set(id, s)
    return true
  }

  /** 对外视图:不含任何密钥 */
  view(a: AccountConfig): AccountView {
    return {
      id: a.id,
      presetId: a.presetId,
      label: a.label,
      state: this.state(a.id),
      ...(a.baseUrl !== undefined && { baseUrl: a.baseUrl }),
      ...(a.models !== undefined && { models: a.models }),
    }
  }
}
