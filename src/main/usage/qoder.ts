import type { StatusbarUsage } from './types'

// Qoder's token is stored in an Electron safeStorage-encrypted keychain blob that only the Qoder
// app can decrypt — Forge cannot auto-read it. A user-pasted token (设置→插件→凭据) is the only
// path; the official usage endpoint shape is still unverified, so we surface an honest message.
export async function fetchQoderUsage(cred?: string): Promise<StatusbarUsage> {
  if (cred?.trim()) throw new Error('已保存 Qoder 凭据，但官方额度接口待接入')
  throw new Error('Qoder 无法自动读取凭据，请在下方「凭据」粘贴 token')
}
