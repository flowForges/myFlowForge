import { chmodSync, existsSync } from 'node:fs'
import { z } from 'zod'
import { generateIdentity, fromBase64, toBase64, type Identity } from '@shared/remote/e2e'
import { readJson, writeJson } from '../config/store'
import { sysFile } from '../config/paths'

/**
 * 这台机器的**长期身份**。整条远程链路唯一的信任锚点。
 *
 * ★★公钥印在配对链接 / 二维码里,由人从电脑屏幕搬到手机上 —— **这是整条链路里唯一
 *  不经过网络的一步**。客户端认的是这把公钥,不是地址:换了中转、换了 IP、换了端口,
 *  认的还是同一台机器。所以这把钥匙**一台机器一辈子一把**,换了就等于所有配过对的设备
 *  全部要重新扫码。
 *
 * ★私钥落盘,`0600`。它不是访问令牌那种"泄露了换一个就行"的东西:拿到它的人可以
 *  完整冒充这台 daemon 对所有已配对设备说话,而那些设备**没有任何办法**察觉。
 *
 * ★★**绝不放进 `settings.json`**。那份东西会被广播给每一个连上来的客户端
 *  (`settings:changed` 走的是同一条 hub 总线),私钥会跟着一起飞出去。
 *  单独一个文件,而且下面那张 schema 里也只有这两个字段 —— 别往这儿加任何别的设置。
 */

const IdentityFileSchema = z.object({
  /** base64 的 Ed25519 公钥(32 字节)。 */
  pk: z.string(),
  /** base64 的 Ed25519 私钥(64 字节,tweetnacl 的格式里含公钥)。 */
  sk: z.string(),
})

const identityFile = () => sysFile('identity.json')

/** 磁盘上那份能不能用。★长度不对就是坏的,宁可重新生成也不要拿半把钥匙去签名。 */
function decode(raw: { pk: string; sk: string }): Identity | null {
  const publicKey = fromBase64(raw.pk)
  const secretKey = fromBase64(raw.sk)
  if (!publicKey || publicKey.length !== 32) return null
  if (!secretKey || secretKey.length !== 64) return null
  return { publicKey, secretKey }
}

/**
 * 读这台机器的长期身份,**没有就当场生成一把并落盘**。
 *
 * ★幂等,而且第一次调用之前不生成任何东西 —— 一个从来不开远程的用户,磁盘上不该多出
 *  一把私钥。
 */
export function readIdentity(): Identity {
  const existed = existsSync(identityFile())
  const raw = readJson(identityFile(), IdentityFileSchema, () => ({ pk: '', sk: '' }))
  if (existed) {
    const id = decode(raw)
    if (id) return id
    // ★★走到这儿意味着磁盘上那份**坏了**(被截断、被手改、被别的工具覆盖)。
    //  重新生成是唯一能继续的路,但它会让所有已配对的设备失效 —— 所以必须留下一行日志级别的
    //  痕迹。这里没有 logger,交给调用方:它拿到的公钥和上次不一样,设置界面上那个二维码
    //  会跟着变,用户至少看得见"要重新扫一次"。
  }
  const fresh = generateIdentity()
  writeIdentity(fresh)
  return fresh
}

/** 落盘并收紧权限。 */
export function writeIdentity(id: Identity): void {
  writeJson(identityFile(), { pk: toBase64(id.publicKey), sk: toBase64(id.secretKey) })
  try {
    // ★`writeJsonAtomic` 是"写临时文件再改名",新文件继承的是 umask,通常 0644。
    //  所以 chmod 必须在写**之后**,而且每次都做 —— 只在创建时做的话,一次
    //  「用别的工具改了这个文件」就会把权限放回去,而且没人会注意到。
    chmodSync(identityFile(), 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作,别因此让整个远程功能起不来。
  }
}

/** 磁盘上有没有身份。★不生成 —— 给"要不要显示配对二维码"这类只读判断用。 */
export const hasIdentity = (): boolean => existsSync(identityFile())
