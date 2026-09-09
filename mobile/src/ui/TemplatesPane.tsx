import { useState } from 'react'
import { View } from 'react-native'
import { CH } from '../../../src/main/ipc/channels'
import { useC } from '../theme/theme'
import { Btn, Empty, List, Loading, Note, Row, Sec, T } from './kit'
import { Sheet } from './Sheet'
import { useConn } from '../net/conn'
import { useStore } from '../data/store'
import { useStageCatalog, useTemplates, type Template, type TemplateStage } from '../data/useWorkflow'
import { tap } from './haptics'

/**
 * 工作流**模板库** —— 第二格里的第三段。
 *
 * ★★这一段回答的问题是「**这台机器上有哪些工作流模板**」,和启动屏那张列表**不是一回事**:
 *  · 启动屏列的是 `ws.workflows` —— 「**这个工作区**里有哪些工作流」,是模板的一份副本;
 *  · 这里列的是 `~/.myFlowForge/workflows.json` —— 跨工作区的原型,在电脑端「设置 → 工作流」里维护。
 *  用户 2026-09-09 问的正是这个:「是否支持查看有哪些工作流模板,在某个会话里启动的时候,
 *  可以选择这个模板」。答案原来是「不支持」——模板**只在新建工作区向导里**被用过一次,
 *  工作区一旦建好就再也加不进新模板了(**电脑端也一样**,不是手机端单独缺)。
 *
 * ★★「用到工作区」是**复制,不是引用**。服务端 `addWorkflowFromTemplate` 把模板的阶段
 *  物化成 `ws.workflows` 里的一条 —— 之后改模板不会动到已经加过的工作区。
 *  留空引用的话,以后在电脑上改一下模板,所有引用它的工作区**跑起来的东西全变了**,
 *  而屏幕上一个字都不会提示。
 *
 * ★手机上**不给改模板本身**:模板是「所有工作区的原型」,改错一处影响面比改一个工作区大得多,
 *  而这一屏连提示词都显示不下。改模板仍然只在电脑端。这里只做两件事:看、用。
 */
export function TemplatesPane() {
  const c = useC()
  const { invoke, online } = useConn()
  const { groups, refresh } = useStore()
  const { templates, loading, error, reload, canUse } = useTemplates()
  /**
   * ★★阶段名**不能照模板里那个字段读**。模板里对阶段库的引用只冗余缓存了一份 key/name,
   *  而那份缓存**是会过期的**(假 daemon 的 fixture 里就写死了一个「缓存的旧名字」专门钓这个)。
   *  真身在阶段库里 —— 也就是 `workflow:stage-catalog` 给的那份,**主机算好了给**。
   *  照缓存显示的话,这一行写的是一个早就改过名的阶段,而屏幕上完全看不出来。
   */
  const { builtin, custom } = useStageCatalog()
  const label = (s: TemplateStage & { libId?: string }) => {
    if (s.libId) return custom.find((x) => x.libId === s.libId)?.name ?? s.name ?? s.key
    return s.name ?? builtin.find((x) => x.key === s.key)?.name ?? s.key
  }

  /** 正在给哪个模板挑工作区。null = 没在挑。 */
  const [picking, setPicking] = useState<Template | null>(null)
  const [busy, setBusy] = useState(false)
  const [sheetErr, setSheetErr] = useState<string | null>(null)
  /** 加成功之后那句话。★留在屏幕上,不做成一闪而过的 toast —— 它要回答「然后我去哪儿用它」。 */
  const [done, setDone] = useState<string | null>(null)

  const use = async (t: Template, wsPath: string, wsName: string) => {
    setBusy(true)
    setSheetErr(null)
    try {
      await invoke(CH.workspaceAddWorkflowFromTemplate, [{ workspacePath: wsPath, templateId: t.id }])
      tap('done')
      setPicking(null)
      setDone(`「${t.name}」已经加进「${wsName}」—— 在那个工作区启动工作流时就能选它了。`)
      // 工作区那份数据变了(多了一条工作流),把 store 捅一下,免得启动屏还是旧的。
      refresh()
    } catch (e) {
      tap('blocked')
      // ★服务端拒绝的原话必须原样显示(「这个工作区已经有一条叫『X』的工作流了」)——
      //  换成「添加失败」的话,人根本不知道该怎么办。
      setSheetErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!online) return <Empty title="未连接" desc="模板存在那台机器上,连上才看得到。" />
  if (loading) return <Loading title="正在读模板…" />

  return (
    <>
      {error ? (
        <View style={{ margin: 15, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
          {/* ★「读不到」和「一个模板都没有」是两件事,不许长成同一片空白。 */}
          <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>读不到模板库:{error}</T>
          <View style={{ height: 10 }} />
          <Btn size="sm" onPress={reload}>重试</Btn>
        </View>
      ) : null}

      {done ? (
        <View style={{ margin: 15, padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bg2 }}>
          <T style={{ fontSize: 13, lineHeight: 20, color: c.fg }}>{done}</T>
        </View>
      ) : null}

      {!error && templates.length === 0 ? (
        <Empty title="这台机器上还没有模板" desc="模板在电脑端「设置 → 工作流」里建。" />
      ) : null}

      {templates.length > 0 ? (
        <>
          <Sec>{templates.length} 个模板</Sec>
          <List>
            {templates.map((t) => (
              <Row key={t.id}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>{t.name}</T>
                  {/* ★把阶段名摊出来,而不是只写「4 个阶段」:模板之间的**区别**就在阶段上,
                      只给个数字等于要人挨个点进去猜。 */}
                  <T numberOfLines={2} style={{ fontSize: 11.5, color: c.muted, marginTop: 3 }}>
                    {t.stages.length ? t.stages.map(label).join(' · ') : '这个模板里没有阶段'}
                  </T>
                </View>
                {canUse && t.stages.length > 0 ? (
                  <Btn size="sm" onPress={() => { setSheetErr(null); setPicking(t) }}>用到…</Btn>
                ) : null}
              </Row>
            ))}
          </List>
          {canUse ? (
            <Note>「用到…」把模板复制一份进某个工作区。之后改模板不会动到已经加过的那份。</Note>
          ) : (
            /* 决策 B-2:老主机上没有这个方法 ⇒ 不摆按钮 + 说清为什么,而不是摆一个点了没反应的。 */
            <Note>这台主机的版本还不支持把模板加进工作区。升级那台机器上的 myFlowForge 就有了。</Note>
          )}
        </>
      ) : null}

      <Sheet
        open={!!picking}
        onClose={() => setPicking(null)}
        title={picking ? `把「${picking.name}」加到哪个工作区` : ''}
        sub="复制一份进去,以后改模板不影响它"
      >
        {sheetErr ? (
          <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
            <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{sheetErr}</T>
          </View>
        ) : null}
        {groups.length === 0 ? (
          <T style={{ fontSize: 13, color: c.muted }}>还没有工作区。先建一个,才有地方放它。</T>
        ) : (
          groups.map((g) => (
            <Btn key={g.ws.path} block disabled={busy} onPress={() => picking && void use(picking, g.ws.path, g.ws.name)}>
              {g.ws.name}
            </Btn>
          ))
        )}
      </Sheet>
    </>
  )
}
