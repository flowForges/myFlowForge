import { createContext } from 'react'

/**
 * 手机端图片:**只放行本地图**。
 *
 * ★★远程 src 照旧不画(降级成链接)。理由是 `htmlParse.ts` 文件头那条不变量:
 *  「绝不执行、绝不联网 —— 远程 src 是追踪信标 + 出口 IP 泄露」。模型的输出是不可信输入,
 *  让它决定手机去请求哪个地址,等于把出口 IP 送给任何一个能影响模型输出的人。**这条不拆。**
 *
 * ★但本地图不属于这条:它走的是 `file:image`,而那个 channel 不在 `CLIENT_ONLY` 里 ⇒
 *  路由到**当前连的那台 host**,用的是已经鉴权加密的那条信道,**不碰任何第三方**。
 *  越界判断在 host 那边由 `resolveFileRef` 做(和对话里文件链接同一套守卫)。
 *
 * ★`data:` 也当远程挡掉:它不发请求,但模型可以把一整张图 base64 塞进正文
 *  —— 那是几百 KB 的会话历史和渲染开销,而且绕过了「图必须在工作区内」这条。
 */
export function isRemoteSrc(src: string): boolean {
  return /^(https?:|data:|blob:|\/\/)/i.test(src.trim())
}

/** 整行只有一张图时的匹配(前后空白允许)。夹在句子中间的图不走这条 —— 见 mdImage.test.ts。 */
export const IMG_ONLY_LINE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

/**
 * 解析本地图相对路径的基准目录,由对话屏提供(它才知道当前工作区)。
 *
 * ★空数组 = **什么都不读**。别的屏(归档、模板…)复用 MessageBody 时拿不到它,
 *  那里的图就退回占位符 —— 宁可不画,不要去猜一个 base。
 */
export const MdImageBasesCtx = createContext<string[]>([])
