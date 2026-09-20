/**
 * 「关于」那一屏上摆哪几行、断线时写什么。
 *
 * ★★这三行**没有一个是新数据**,全是已经在跑的东西:手机端版本(和 daemon 比主版本号的那一个)、
 *  主机版本、主机认得多少个方法。它们值得凑成一屏,是因为**排查连不上/功能不见了的时候要的正是这三个数**:
 *  两端主版本号对不上 → 连都连不上(`hostClient` 直接按主版本号拒);
 *  版本对得上但方法少 → 某个功能整个置灰。三个数分散在三屏的时候,没人能把这条因果串起来。
 *
 * ★★**凡是对面的数,断着的时候一律写「连上才知道」,绝不留上一次的旧值。**
 *  留旧值最坑的场景是:对面升级过了、而这台手机连不上,屏幕上那个旧版本号会让人
 *  一路去查一个根本不存在的版本差。这条规矩和 `app/host.tsx`、设置屏主机行是同一条。
 *
 * ★不编任何东西:没有官网、没有更新日志、没有开源许可页 —— 这个 app 里都不存在,
 *  摆一条点了没反应的链接比不摆糟得多。
 *
 * ★这个文件刻意不 import 任何东西(同 `tree.ts` / `wsTile.ts`),好在 node 环境下单测。
 */

export type AboutRow = {
  label: string
  value: string
  /**
   * 这个值是不是**真的**。false = 它是那句「连上才知道」的占位,调用方据此把它画淡
   * (别让占位文字长得和真数据一样重)。
   */
  known: boolean
}

/** 对面没连上时,凡是对面的数都写这一句。 */
export const UNKNOWN = '连上才知道'

export function aboutRows(x: {
  /** ★必须由调用方从 `CLIENT_VERSION`(它来自 `app.json`)传进来。这里**不许**写死一个版本号:
   *  写死的那一份和握手时报上去的那个迟早对不上,界面写着 1.2 而实际报的是 1.1。 */
  clientVersion: string
  /** 连上了才有;没连上传 null。 */
  host: { version: string; methods: number } | null
}): AboutRow[] {
  return [
    { label: '手机端版本', value: x.clientVersion, known: true },
    { label: '主机版本', value: x.host ? x.host.version : UNKNOWN, known: !!x.host },
    { label: '主机提供的方法', value: x.host ? `${x.host.methods} 个` : UNKNOWN, known: !!x.host },
  ]
}
