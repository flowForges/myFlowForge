import { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'
import { CH } from '../../../src/main/ipc/channels'
import type { WorkspaceMeta } from '../../../src/shared/types'
import { fmtRelTime } from '../../../src/shared/relTime'
import { orderArchived } from '../data/archivedOrder'
import { useC } from '../theme/theme'
import { Btn, Empty, List, Row, T } from './kit'
import { useConn } from '../net/conn'
import { useStore } from '../data/store'

/**
 * 已归档的工作区 —— 归档后从根屏的会话列表消失,这里是**唯一看得见的回去的路**
 * (设计文档 §7.6:归档必须有条回得来的路,否则等于弄丢)。
 *
 * ★★2026-09-09 从**独立一屏**(`app/archived.tsx`)变成第二格里的一段。用户原话:
 *  「将菜单的第二栏 工作区 改成综合类的,分成 工作区、归档、工作流」。
 *  搬完那一屏就删了 —— 留着等于同一件事两个入口,而那正是这一格当初存在的理由
 *  (「工作区的管理原来散在三个地方」)。所以这里只出**内容**,不出 TopBar:
 *  标题栏归 `(tabs)/workspaces.tsx` 那一份,三段共用。
 *
 * ★不借 `useStore()` 的 `groups` —— 那份数据已经把归档的过滤掉了(`store.tsx` 里
 *  `wss.filter(w => !w.archived)`),这一段得自己拉一份**全量**列表再挑 `archived` 的。
 */
export function ArchivedPane() {
  const c = useC()
  const { online, invoke } = useConn()
  // ★恢复成功之后不能只重拉**这一段自己**那份全量列表 —— 根屏读的是 `useStore()` 那份 `groups`
  //  (已经把归档的过滤掉),它只在 `[online, invoke, epoch, tick]` 变化时重拉一次快照。
  //  两份是完全独立的状态,不调 `store.refresh()` 去 bump 那个 `tick`,
  //  这一段看着「已经恢复」,回到会话列表那台工作区却还是不在 —— 这正是 §7.6 要防的「回不来」。
  const { refresh: refreshStore } = useStore()
  // null = 还没拉到过;拉到之后哪怕是空数组也不再是 null —— 用来区分「正在读取」和「读到了但是空」。
  const [all, setAll] = useState<WorkspaceMeta[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // 正在恢复的那个工作区 path

  const load = useCallback(async () => {
    setErr(null)
    try {
      const wss = (await invoke(CH.workspacesList)) as WorkspaceMeta[]
      setAll(wss)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [invoke])

  useEffect(() => {
    if (!online) return
    void load()
  }, [online, load])

  const archived = orderArchived(all ?? [])

  const restore = async (path: string) => {
    setBusy(path)
    setErr(null)
    try {
      await invoke(CH.workspaceRestore, [path])
      // 恢复成功后留在原地、重拉一遍**这一段自己**的列表 —— 这一行从列表里消失就是看得见的反馈,
      // 不用另外弹一句「已恢复」。
      await load()
      // ★同时把根屏那份 `store` 也捅一下(见上面 `refreshStore` 的注释)。
      refreshStore()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {err ? (
        <View style={{ margin: 15, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
          <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{err}</T>
        </View>
      ) : null}

      {!online ? (
        <Empty title="未连接" desc="连上主机才能看归档列表。" />
      ) : all === null ? (
        <Empty title="正在读取…" />
      ) : archived.length === 0 ? (
        <Empty title="没有归档的工作区" desc="在「工作区」那一段长按一行就能归档。" />
      ) : (
        <List>
          {archived.map((w) => (
            <Row key={w.path}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                  {w.name}
                </T>
                <T mono style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                  {fmtRelTime(w.archivedAt ?? 0, Date.now())
                    ? `归档于 ${fmtRelTime(w.archivedAt ?? 0, Date.now())}`
                    : '归档时间未知'}
                </T>
              </View>
              <Btn size="sm" disabled={busy === w.path} onPress={() => void restore(w.path)}>
                恢复
              </Btn>
            </Row>
          ))}
        </List>
      )}
    </>
  )
}
