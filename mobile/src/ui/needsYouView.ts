/**
 * 顶部「需要你」那一块**折起来之后还剩什么**。
 *
 * ★★这个文件的全部意义是钉死一条**承诺**:折叠只准藏细节,不准藏事实。
 *  这一块存在的理由是「代理停在门上而你不在电脑前」(设计文档 §1.1),
 *  而 `NeedsYou.tsx` 顶上那句「**没有这一块 = 没你的事**」是它对人做的承诺 ——
 *  于是「有事但整块看不见」这一种状态是**不允许存在**的。
 *  所以折叠折的是**列表**,头(带着「4 条等你 · 2 道门」那个数)在两种状态下一字不差。
 *
 * ★为什么要单独一个 node 能跑的文件来说这件事:这条承诺在组件里是「JSX 的哪一段包在
 *  `folded &&` 里面」——一次顺手的重构就能把头也包进去,而带 RN 的组件在这个仓库
 *  **一行测试都跑不了**(根 vitest.config.ts 的 mobile project 是 node 环境)。
 *  抽成一个纯函数之后,「折起来仍然 render、head 一字不差」变成一条真能红的断言。
 */

export type NeedsYouView =
  /** 整块不画。**真的什么事都没有**才走这一档 —— 折叠永远走不到这里。 */
  | { render: false }
  | {
      render: true
      /** 头上那句话。★和 `folded` 无关,这是上面那条承诺的落点。 */
      head: string
      /** 底下列几条。折起来就是 0(头还在),展开就是全部。 */
      rows: number
    }

/** 头上那句话。门和「在跑 / 未读」不是一回事,有门就单独报数。 */
export function needsYouHead(count: number, gateCount: number): string {
  return gateCount > 0 ? `${count} 条等你 · ${gateCount} 道门` : `${count} 条等你`
}

/** 折叠三角。▾ = 开着,▸ = 收着 —— 和 `Sec`、工作区分组头同一套字形,别在这儿另发明一套。 */
export function foldCaret(folded: boolean): string {
  return folded ? '▸' : '▾'
}

/**
 * 无障碍标签。★收起状态下必须**把数念出来**:读屏的人看不见那个三角,
 *  只念一句「展开」等于把「有几件事等你」整个吞掉,和视觉上藏掉头是同一个错。
 */
export function foldA11yLabel(folded: boolean, count: number, gateCount: number): string {
  return folded ? `展开:${needsYouHead(count, gateCount)}` : '收起'
}

export function needsYouView(count: number, gateCount: number, folded: boolean): NeedsYouView {
  // ★门槛是「一条都没有」,不是「折起来了」。折叠改的只有 rows。
  if (count <= 0) return { render: false }
  return { render: true, head: needsYouHead(count, gateCount), rows: folded ? 0 : count }
}
