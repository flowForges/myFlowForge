/**
 * 「这道门上该不该摆『👁 看看』?」—— 门 → 变更页那条捷径的唯一闸门。
 *
 * ★这个文件刻意**不 import 任何东西**(和 `reportSeen.ts` / `sessionStatus.ts` 同一套纪律):
 *  判断本来内联在 `app/chat.tsx` 的 JSX 里,而那个文件一路 import 到 react-native,
 *  vitest 的 mobile project 是 node 环境,渲染不了 —— 于是这条闸门一行覆盖都没有。
 *
 * ★★闸门存在的理由(**别把 `viewingWsPath` 那一条当多余的防御删掉**):
 *  对话屏在本会话没门时会**从别的工作区借**一道门钉着(那行「这道门来自另一个会话」就是它),
 *  而 `app/exec.tsx` 的变更是按**你正在看的那条会话**的 `wsPath` 拉的。两者对不上时点「看看」,
 *  屏幕上是 W1 的 diff、底下钉着 W2 的门、「允许」就在旁边 —— 唯一的破绽是顶栏写 W1 而
 *  门上写「位置 W2」。这颗按钮存在的全部理由是「敢不敢让它继续的唯一依据」,给错依据比不给更坏。
 *  借来的那道门不另配入口:那行字本身可点、回列表,列表带工作区上下文,进对的会话再看 diff。
 *
 * ★按 `wsPath` 比,而**不是**按「这道门是不是本会话的」比:变更是**工作区级**的,
 *  同一个区里别的会话升起的门,那份 diff 照样是对的依据。
 *
 * ★只有 `confirm` 门配它:选择题门问的是「选哪个方案」,diff 帮不上忙。
 */
export function canPeekGate(
  gate: { kind: string; wsPath: string } | null | undefined,
  viewingWsPath: string | null | undefined,
): boolean {
  if (!gate) return false
  // 没选中任何会话时 `exec.tsx` 根本没有 wsPath 可拉,那一屏是空的 —— 推过去等于推进一个空屏。
  if (!viewingWsPath) return false
  if (gate.kind !== 'confirm') return false
  return gate.wsPath === viewingWsPath
}
