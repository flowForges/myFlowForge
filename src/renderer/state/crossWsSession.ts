/**
 * 点侧边栏里**别的工作区**下面的某条会话。
 *
 * ★★根因(2026-10-21 用户:「点第二条,跳到的却是第一条」):会话选中项**归设备**
 *  (settings.lastActiveSession,见 useSessions 顶上那段),它的优先级高于主机那份 activeSessionId。
 *  原来这里只发了 `sessionSwitch`(写主机那份),没写这台设备的选择 —— 切过去之后 useSessions 认的
 *  还是这台设备上次在那个工作区停留的会话,于是落在第一条。宠物「去 app 处理」那条路早就两件都做了
 *  (App.tsx onNavigateWorkspace),这里照它补齐:
 *   1. `remember` —— 记成这台设备的选择(界面认这个);
 *   2. `sessionSwitch` —— 告诉主机(机器人、新设备第一次进来看哪个,还认它)。
 * ★先等主机写完再切工作区:切过去会立刻读会话清单,别让它读到一半写好的状态。
 *  切换失败(会话已被删掉、主进程报错)也照样切过去 —— 落在那个工作区里还存在的会话上,总比点了没反应好。
 */
export async function switchToSessionInOtherWorkspace(
  wsId: string,
  sessionId: string,
  deps: {
    remember: (wsId: string, sessionId: string) => void
    sessionSwitch?: (a: { workspacePath: string; sessionId: string }) => Promise<unknown>
    openWorkspace: (wsId: string) => void
  },
): Promise<void> {
  deps.remember(wsId, sessionId)
  try { await deps.sessionSwitch?.({ workspacePath: wsId, sessionId }) } catch { /* 见上 */ }
  deps.openWorkspace(wsId)
}
