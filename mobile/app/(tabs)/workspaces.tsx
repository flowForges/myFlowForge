import { useState } from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { CH } from '../../../src/main/ipc/channels'
import type { WorkspaceMeta } from '../../../src/shared/types'
import { useC } from '../../src/theme/theme'
import { Btn, Empty, Field, List, Note, Row, Sec, T, Tabs, TopBar, TopTitle } from '../../src/ui/kit'
import { ArchivedPane } from '../../src/ui/ArchivedPane'
import { TemplatesPane } from '../../src/ui/TemplatesPane'
import { Sheet } from '../../src/ui/Sheet'
import { useConn } from '../../src/net/conn'
import { useStore } from '../../src/data/store'
import { ROUTES } from '../../src/nav/routes'
import { confirmDestructive } from '../../src/ui/confirmDestructive'
import { tap } from '../../src/ui/haptics'

/**
 * 工作区 · 底部第二格。
 *
 * ★★2026-09-02 用户原话:「app 里中间的菜单,现在是主机,感觉有点浪费」。确实 ——
 *  主机那一格里全是**配对时用一次、之后再不碰**的事(列表/添加/删除/改名),
 *  而「现在连着哪台 + 快切」首页顶栏的 `HostBanner` 早就在做了。它退回设置里的一行。
 *
 * ★这一格顶上来是因为**工作区的管理原来散在三个地方**:新建是首页一颗 ＋、置顶/改名/归档
 *  靠首页上看不见的长按和左滑、而「已归档」莫名其妙在**设置**里(归档的是工作区,不是设置)。
 *  一件事分四处,哪一处都不完整。
 *
 * ★★和首页**不重复**,两屏回答的是两个问题:
 *  · 首页 = 「在跑什么 / 什么等我」—— 主体是**会话**,工作区只是分组头;
 *  · 这一屏 = 「我有哪些工作区、它们什么状况」—— 一区一行,没有会话,能一眼数完。
 *  首页那些长按/左滑**保留**:在你正看着的那一行上顺手做掉,永远比切一个 tab 快。
 *  这一屏是「专门来管」的地方,不是唯一的地方。
 *
 * ★下拉刷新和首页同一份实现(`store.refresh()` 返回的 promise,见 `refreshGate.ts`):
 *  在电脑上新建的工作区,这一屏也得看得见。
 *
 * ★★2026-09-09 这一格从一张列表变成**三段**(工作区 / 归档 / 工作流)。用户原话:
 *  「将菜单的第二栏 工作区 改成综合类的,分成 工作区、归档、工作流,后续再考虑增加其他的」。
 *  三段的共同点是「**我有哪些东西、它们什么状况**」,和首页那个「在跑什么 / 什么等我」正交。
 *  · 归档:原来在「其它」里点进另一屏(`app/archived.tsx`,已删)。同一件事两个入口正是
 *    这一格当初存在的理由(「工作区的管理原来散在三个地方」),所以搬进来之后那一屏就删掉了。
 *  · 工作流:**模板库**(这台机器上有哪些模板),不是「这个工作区里有哪些工作流」——
 *    后者归启动屏。两者的区别见 `TemplatesPane` 顶上的注释。
 * ★分段用 `Tabs`(和 `exec.tsx` 同一个控件),不是三个 tab bar 格子:tab bar 那一层是
 *  「app 的几大块」,而这三段是同一块里的三个视角。
 */
export default function Workspaces() {
  const c = useC()
  const { online, invoke } = useConn()
  const { groups, gatesFor, loading, refresh, setPinned, archive, ensureWs } = useStore()

  /** 三段里的哪一段。★不持久化:每次进来落回「工作区」—— 这一格的主语就是它。 */
  const [seg, setSeg] = useState<'ws' | 'archived' | 'flows'>('ws')
  const [pulling, setPulling] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 长按呼出的操作单。存整份 meta —— 单子里要读 `pinned` 决定按钮写「置顶」还是「取消置顶」。 */
  const [sheet, setSheet] = useState<WorkspaceMeta | null>(null)
  const [sheetErr, setSheetErr] = useState<string | null>(null)
  /** 改名单子。`orig` 是打开那一刻的原名、只读 —— 输入框一改就不再回答「我改的是哪一个」了。 */
  const [rename, setRename] = useState<{ path: string; name: string; orig: string } | null>(null)
  const [renameErr, setRenameErr] = useState<string | null>(null)

  const togglePinned = async (ws: WorkspaceMeta) => {
    setBusy(true)
    setSheetErr(null)
    try {
      // ★到了上限服务端会 throw(`最多只能置顶 N 个工作区`),那句话必须原样显示出来 ——
      //  吞掉的话人只会觉得点了没反应。
      await setPinned(ws.path, !ws.pinned)
      setSheet(null)
    } catch (e) {
      setSheetErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const archiveWs = (ws: WorkspaceMeta) => {
    void confirmDestructive({
      title: '归档工作区',
      message: `归档「${ws.name}」?归档后从会话列表消失,在下面「已归档」里恢复。`,
      confirmLabel: '归档',
    }).then(async (yes) => {
      if (!yes) return
      setBusy(true)
      setSheetErr(null)
      try {
        await archive(ws.path)
        // ★★震动等 `await` 真的成功了才打:失败的同一瞬间手上震「搞定了」而屏幕上弹错误,
        //  是 `haptics.ts` 里 destructive 那条设计专门要防的误导。
        tap('destructive')
        setSheet(null)
      } catch (e) {
        tap('blocked')
        setSheetErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    })
  }

  const submitRename = async () => {
    if (!rename) return
    const name = rename.name.trim()
    // ★空名不提交:`workspaces:rename` 服务端不校验,提交上去会得到一个没名字的工作区。
    if (!name) return
    setBusy(true)
    setRenameErr(null)
    try {
      await invoke(CH.workspaceRename, [{ path: rename.path, name }])
      setRename(null)
      void refresh()
    } catch (e) {
      setRenameErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* tab 的一格没有「上一层」,所以没有 `‹` —— 留着会变成一颗跳去别的 tab 的假返回键。 */}
      <TopBar>
        {/* ★标题跟着段走。写死「工作区」的话,站在模板段上看到的是
            「工作区 / 这台机器上的工作流模板」—— 标题和它自己的副标题打架。
            底部那一格仍然叫「工作区」(那是这一格的名字),两者不冲突。 */}
        <TopTitle
          title={seg === 'ws' ? '工作区' : seg === 'archived' ? '已归档' : '工作流模板'}
          sub={seg === 'ws' ? '一堆项目 + 一条工作流' : seg === 'archived' ? '恢复后回到会话列表' : '在电脑端「设置 → 工作流」里维护'}
        />
      </TopBar>
      <Tabs
        items={[
          { key: 'ws' as const, label: '工作区' },
          { key: 'archived' as const, label: '归档' },
          { key: 'flows' as const, label: '工作流' },
        ]}
        value={seg}
        onChange={(k) => { tap('switchTab'); setSeg(k) }}
      />

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        // ★下拉刷新只挂在「工作区」这一段:另外两段各自管着自己的数据(归档那段自己拉全量列表、
        //  模板那段拉模板库),挂上去会变成「拉了半天刷新的是别人」。
        refreshControl={
          <RefreshControl
            refreshing={pulling}
            enabled={online && seg === 'ws'}
            onRefresh={() => {
              // ★拉到位松手 = 手势越过阈值,和左滑到位同一类,轻轻一下确认「收到了」。
              //  没有它的话,这个 app 里唯一没有手感的手势就是它(用户当场问出来的)。
              tap('pullRefresh')
              setPulling(true)
              void refresh().finally(() => setPulling(false))
            }}
            tintColor={c.muted}
            colors={[c.accent]}
            progressBackgroundColor={c.surface}
          />
        }
      >
        {seg === 'archived' ? (
          <ArchivedPane />
        ) : seg === 'flows' ? (
          <TemplatesPane />
        ) : !online ? (
          <Empty title="未连接" desc="连上才有数据 —— 这里不会拿旧内容假装在线。" />
        ) : loading ? (
          <Empty title="正在读取…" />
        ) : groups.length === 0 ? (
          <>
            <Empty title="这台机器上还没有工作区" desc="工作区是一堆项目 + 一条工作流。先建一个,才有地方开会话。" />
            <View style={{ paddingHorizontal: 30 }}>
              <Btn kind="pri" block onPress={() => router.push(ROUTES.newWorkspace)}>
                ＋ 新建工作区
              </Btn>
            </View>
          </>
        ) : (
          <>
            <Sec>{groups.length} 个工作区</Sec>
            <List>
              {groups.map((g) => {
                const gates = gatesFor(g.ws.path)
                return (
                  <Row
                    key={g.ws.path}
                    gate={gates.length > 0}
                    // ★整行点进去 = 回首页看这个区的会话。这一屏管的是工作区本身,
                    //  「里面有什么」仍然归首页 —— 两屏各答各的,不在这儿再画一遍会话列表。
                    // ★★去之前先 `ensureWs` 把那个区**展开**:分组默认是收起的,不展开的话
                    //  点完落在首页一列收起的分组上,和没点一样 —— 而行尾那个 `›` 已经许诺
                    //  「你会到某个具体的地方」。一颗说了话不算的控件比没有更糟。
                    onPress={() => { ensureWs(g.ws.path); router.push(ROUTES.home) }}
                    onLongPress={() => { setSheetErr(null); setSheet(g.ws) }}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                        {g.ws.pinned ? '📌 ' : ''}{g.ws.name}
                      </T>
                      <T numberOfLines={1} style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                        {g.sessions.length} 条会话
                        {g.ws.projectCount ? ` · ${g.ws.projectCount} 个项目` : ''}
                        {gates.length ? ` · ${gates.length} 道门等你` : ''}
                      </T>
                    </View>
                    <T style={{ fontSize: 16, color: c.faint }}>›</T>
                  </Row>
                )
              })}
            </List>
            <Note>长按一行:置顶 / 改名 / 归档。</Note>

            <View style={{ height: 8 }} />
            <List>
              <Btn kind="pri" block onPress={() => router.push(ROUTES.newWorkspace)}>
                ＋ 新建工作区
              </Btn>
            </List>
          </>
        )}

      </ScrollView>

      {/* 长按呼出的操作单。★和首页那张是**同一套动作**,只是入口不同 —— 两处都要能做,
          因为「正看着那一行顺手做掉」和「专门来管」是两种不同的用法。 */}
      <Sheet open={!!sheet} onClose={() => setSheet(null)} title={sheet?.name ?? ''} sub="置顶 / 改名 / 归档">
        {sheetErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{sheetErr}</T>
          </View>
        ) : null}
        <Btn block disabled={busy} onPress={() => sheet && void togglePinned(sheet)}>
          {sheet?.pinned ? '取消置顶' : '置顶'}
        </Btn>
        <Btn
          block
          disabled={busy}
          onPress={() => {
            if (!sheet) return
            setRenameErr(null)
            setRename({ path: sheet.path, name: sheet.name, orig: sheet.name })
            setSheet(null)
          }}
        >
          改名
        </Btn>
        {/* ★danger 不与主动作相邻(设计文档 §7.2)—— 这段空隙就是唯一目的。 */}
        <View style={{ height: 14 }} />
        <Btn kind="danger" block disabled={busy} onPress={() => sheet && archiveWs(sheet)}>
          归档
        </Btn>
      </Sheet>

      <Sheet
        open={!!rename}
        onClose={() => setRename(null)}
        title="重命名工作区"
        sub={`原名 ${rename?.orig ?? ''}\n列表和分组头都会跟着变`}
      >
        {renameErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{renameErr}</T>
          </View>
        ) : null}
        <Field
          value={rename?.name ?? ''}
          onChangeText={(t) => setRename((prev) => (prev ? { ...prev, name: t } : prev))}
          placeholder="工作区名称"
          autoFocus
          onSubmitEditing={() => void submitRename()}
        />
        <Btn kind="pri" block disabled={busy || !rename?.name.trim()} onPress={() => void submitRename()}>
          保存
        </Btn>
      </Sheet>
    </View>
  )
}
