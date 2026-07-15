/**
 * 检测主代理是否「叙述式假执行」了工作流 —— 即在正文里假称自己已经提交方案 / 正在按工作流执行阶段,
 * 但本轮并没有真的调用 forge_propose_plan(也没有 forge_delegate)工具。
 *
 * 这是 dual-path 设计(028cb9e)下最典型的失守:是否走工作流被完全下放给主代理 LLM,而 LLM 会不调工具、
 * 自己扮演工作流。后果链:没有真实 orchestrator run → 没有确认门(症状「没让我确认」)、没有子代理 session
 * (症状「IDs 面板空」)、叙述文本当普通消息渲染(症状「样式乱」)。commit 108f9ea 只加强了 prompt,拦不住;
 * runTurn 用本函数做服务端兜底:命中 + 本轮没真调任何 forge 工具 → 替它把这次叙述转正成真确认门。
 *
 * 只认【高特异性的「假称提交/执行」签名话术】,宁可漏检也不误伤正常回答 —— 误伤的后果是凭空弹一个可 deny
 * 的门,所以刻意避开裸词(如单独的「工作流」「需求评估」),只在它们与「已提交/等待批准/执行阶段」等强上下文
 * 同现时才判定。调用方还会先 gate「本轮没真调任何 forge 工具」,双保险。正样本/负样本见同名 .test.ts。
 */
const NARRATE_SIGNALS: RegExp[] = [
  // 正文里出现工具名却没真调 —— 叙述式假提交的最强签名(108f9ea「no narrated submit」的目标场景)
  /forge_propose_plan/i,
  // 假称方案已提交给 Forge
  /Forge\s*方案已提交/,
  /方案.{0,6}提交\s*给?\s*Forge/,
  /提交\s*给\s*Forge/i,
  // 引导用户去「Forge UI / 界面」批准(叙述式假门)
  /在\s*Forge\s*UI/i,
  /(等待|待)你?在?\s*(Forge|UI|界面).{0,8}(批准|确认)/,
  /(等待|待)你?.{0,8}(批准|确认).{0,6}(方案|工作流|后)/,
  // 叙述式接受工作流并自扮演:「已收到并会按…工作流…」
  /已收到并会?按.{0,16}工作流/,
  // 阶段名 + 明确执行语气(自扮演阶段执行,而非解释概念)
  /(需求评估|技术方案设计|代码开发|写单测|需求分析)阶段?.{0,16}(开始执行|已开始|已完成|正在执行|马上执行|我来(做|执行|进行))/,
  /(开始|正在)执行.{0,8}(需求评估|技术方案设计|需求分析)/,
]

export function looksLikeNarratedWorkflow(text: string | undefined | null): boolean {
  if (!text) return false
  return NARRATE_SIGNALS.some(re => re.test(text))
}
