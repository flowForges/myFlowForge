/**
 * 启动工作流时,一个阶段**允许用户改什么** —— 电脑端启动门和手机端启动屏共用这一份。
 *
 * ★★为什么非提出来不可:这几条规则原来只写在 `renderer/components/LaunchGateCard.tsx` 里
 *  (`stageAllowsPerProject` 是那儿的一个局部箭头函数)。手机端要做同一件事时如果再抄一份,
 *  两边就会各自演化 —— 而这种走偏**在界面上完全看不出来**:手机上多给一个开关,
 *  发回去的 `perProject` 会把「代码开发」的逐项目扇出**压成单代理**(`buildLaunchPlan`
 *  是逐字照办的),屏幕上只会显示「跑了一个 lane」,没人看得出是哪里错了。
 */

/** 启动信息里一个阶段的形状(`LaunchInfo.workflows[].stages[]` 的子集,只留判定用得到的字段)。 */
export type LaunchStageLike = {
  /** 这个阶段天生按项目扇出 / 写代码(代码开发)。 */
  code: boolean
  /** 这个阶段必须产出一份 markdown 方案文件(技术方案)。 */
  producesDoc?: boolean
}

/**
 * 这个阶段能不能让用户在「单代理 ⇄ 按项目」之间切?
 *
 * ★两个都要排除,理由不同:
 *  · `code`(代码开发):它**本来就是**按项目扇出的,给个开关等于允许把它关成单代理;
 *  · `producesDoc`(技术方案):它要产出一份**唯一的**方案文件,按项目跑会变成 N 份互相打架的方案。
 * ★可切的是「写单测」「代码 CR」这类:一个代理统一做,还是每个项目各来一个,都说得通。
 */
export function stageAllowsPerProject(s: LaunchStageLike): boolean {
  return !s.code && !s.producesDoc
}

/**
 * 这次运行里,这个阶段实际上会不会按项目扇出?
 * = 天生就是的(code),或者可切且用户切到了「按项目」。
 * ★用途之一是**拦确认**:一个按项目跑的阶段开着、却一个项目都没选,那它会得到零个 lane。
 */
export function isPerProjectStage(s: LaunchStageLike, perProject: boolean): boolean {
  return s.code || (stageAllowsPerProject(s) && perProject)
}

/**
 * 这个阶段的 provider/model 能不能在启动时逐阶段挑?
 *
 * ★`code` 阶段不能:它的 provider/model 来自**逐项目**那组选择器(每个项目可以用不同的代理),
 *  再给一个阶段级的picker 就是两个地方说同一件事,而且必然对不上。
 */
export function stageAllowsAgentPick(s: LaunchStageLike): boolean {
  return !s.code
}

/**
 * 组装一条要发给服务端的阶段选择(`LaunchStartConfig.stages[]` 的一项)。
 *
 * ★★`perProject` **只在可切的阶段带上**。给 develop/design 带一个 `perProject: false`,
 *  `buildLaunchPlan` 会逐字照办、把它们的逐项目扇出压成单代理 —— 这正是上面那段注释说的
 *  「看不出来的走偏」。所以这个判断必须和开关的显示条件是**同一个函数**,不能各写各的。
 */
export function buildStageChoice(
  s: LaunchStageLike & { key: string },
  st: { enabled: boolean; provider: string; model: string; perProject: boolean },
  projectAgents?: { name: string; provider: string; model: string }[],
): { key: string; enabled: boolean; provider: string; model: string; perProject?: boolean; projects?: { name: string; provider: string; model: string }[] } {
  const base = {
    key: s.key,
    enabled: st.enabled,
    provider: st.provider,
    model: st.model,
    // 阶段级项目代理:只在真被改过时才带,空着就让主进程回落到工作区里配好的那份。
    ...(projectAgents?.length ? { projects: projectAgents } : {}),
  }
  return stageAllowsPerProject(s) ? { ...base, perProject: st.perProject } : base
}
