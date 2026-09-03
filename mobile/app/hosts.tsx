import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { Btn, Empty, IconBtn, List, LiveDot, Note, Pill, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { Icon } from '../src/ui/Icon'
import { useConn } from '../src/net/conn'
import { type MobileHost } from '../src/net/hosts'
import { useStore } from '../src/data/store'
// 一句人话的连接状态。★这一份和设置屏共用同一个实现,别在任何一边抄第二遍 —— 见该文件注释。
import { describeHostState, hostSubtitle } from '../src/net/hostStatusText'
import { HostIcon } from '../src/ui/HostIcon'
import { HostEditSheet, type HostEditTarget } from '../src/ui/HostEditSheet'
// ★web/native 那条确认框分支收在这一个函数里,原地各写一遍的历史(这里 + archiveWs +
//  confirmDeleteSession)已经收掉了,见它的 JSDoc。
import { confirmDestructive } from '../src/ui/confirmDestructive'
import { ROUTES } from '../src/nav/routes'

export default function Hosts() {
  const c = useC()
  const { hosts, activeHost, state, selectHost, removeHost, updateHost, reconnect } = useConn()
  const { gates } = useStore()

  /**
   * 正在编辑的那一台。★单子本身搬到了 `HostEditSheet`(三处共用),这里只管「编哪一台」——
   * 草稿状态归它自己。
   */
  const [edit, setEdit] = useState<HostEditTarget | null>(null)

  const remove = (h: MobileHost) => {
    void confirmDestructive({
      title: '删除主机',
      message: `删除「${h.label}」?手机上不再记住它的地址和令牌。`,
      confirmLabel: '删除',
    }).then((yes) => { if (yes) void removeHost(h.id) })
  }

  const d = describeHostState(state)

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      {/* ★★2026-09-02:`‹` 回来了 —— 这一屏**又变回次级屏**了(底部第二格让给了「工作区」)。
          用户原话:「app 里中间的菜单,现在是主机,感觉有点浪费」—— 确实:列表/添加/删除/改名
          全是配对时用一次、之后再不碰的事,而「现在连着哪台 + 快切」首页顶栏的 HostBanner
          早就在做了。所以它退回设置里的一行,而那一格给了真正每天要碰的东西。
          ★这也意味着 2026-08-28「主机不许再出现在设置里」那条作废 —— 当时搬出来是因为
          设置屏很长、埋太深;现在设置屏只剩五行,埋不住了。 */}
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="主机" sub="同一时间只连一台" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {hosts.length === 0 ? (
          <Empty
            title="还没有配过主机"
            desc={'在电脑上跑起 daemon,把它打印的地址填进来。\n手机和电脑要在同一个 wifi 里。'}
          />
        ) : (
          <>
            <Sec>已配对</Sec>
            <List>
              {hosts.map((h) => {
                const active = h.id === activeHost?.id
                const st = active ? d : { text: '未连接', tone: 'idle' as const }
                // ★★同一条 online 门,第五处:`active` 只判「是不是当前选中那台」,跟
                //  「连没连上」是两件事 —— 断线时这里原来还是照报 `gates.length`,主机屏上
                //  「当前这台」会顶着一枚上一次连上时留下的旧门徽章,和 HostBanner/tab 角标/
                //  门汇总句/换主机单是同一个缺陷。`st.tone === 'ok'` 就是「这台连着」——
                //  它和 `active && st.tone === 'ok'` 那颗「已连接」pill(下面)用的是同一个判断。
                const gateN = active && st.tone === 'ok' ? gates.length : 0
                // 「这一行就是当前连着的那台」。下面三处(› 附件、「已连接」pill、整行点击的去向)
                // 用的是同一个判断,别各写一份。
                const isCurrent = active && st.tone === 'ok'
                return (
                  <Row
                    key={h.id}
                    // ★★2026-08-29 真机第六轮:原来整行永远是「切到这台」,详情只挂在行尾那颗 ›
                    //  上。用户的原话是「点击列表,无法进入到详情,只能点 > 才能进入」—— iOS 上
                    //  一行右端画着 › 就意味着「点这一行会进去」,把它降级成一颗独立小按钮是在跟
                    //  系统习惯对着干,而且那颗按钮只有 44pt 宽,行的其余部分全是另一个意思。
                    //  ★当前连着的那一行,「切到这台」本来就是空操作 —— 所以整行让给详情,
                    //   一点损失都没有。别的行没有 ›,整行仍然是「切过去」,那是它们唯一诚实的动作
                    //   (`/host` 讲的只有当前连着的那一台,见下面那段 ★★)。
                    onPress={isCurrent ? () => router.push(ROUTES.host) : () => void selectHost(h.id)}
                    // ★★改名走长按,不再多摆一颗按钮:这一行右端已经有「删除」和「详情」两颗
                    //  44×44 的键,第三颗会把名字那一栏挤到只剩几个字(而名字正是这一行的主角)。
                    //  ★长按是**每一行**都能用的,包括没连着的那些 —— 名字纯存在这台手机上,
                    //   改它不需要连上那台机器。
                    onLongPress={() => setEdit({ id: h.id, label: h.label, icon: h.icon })}
                  >
                    <HostIcon icon={h.icon} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T numberOfLines={1} style={{ fontSize: 15, fontWeight: '600', color: c.fg }}>
                        {h.label}
                      </T>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                        {active && <LiveDot tone={st.tone === 'idle' ? 'off' : st.tone} />}
                        <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, flexShrink: 1 }}>
                          {/* 连上了报地址和对面版本;没连上报**为什么**。★和设置屏同一份实现。 */}
                          {hostSubtitle(h.url, state, active)}
                        </T>
                      </View>
                    </View>
                    {gateN > 0 ? (
                      <Pill tone="gate">{gateN} 个门</Pill>
                    ) : isCurrent ? (
                      <Pill tone="run">已连接</Pill>
                    ) : null}
                    {/* ★★这颗原来是 `hitSlop={10}` + 4pt 内边距 —— 实际热区约 **23×20pt**,
                        而它是这一屏唯一的**破坏性**控件(删掉主机 = 忘掉地址和令牌)。
                        `hitSlop` 在祖先紧贴子节点时是**死的**(Fabric 的 `overflowInset`),
                        而这一行的外层 Pressable 正好紧贴着它 —— 旁边那颗 › 早就是这么修的,
                        它俩挨着,却一个 44×44 一个 23×20。真长出来的只有 `width`/`height`。
                        ★按下态是必须的:热区变大之后,「点没点到」的唯一反馈就是它。 */}
                    <Pressable
                      onPress={() => remove(h)}
                      accessibilityLabel={`删除 ${h.label}`}
                      style={({ pressed }) => [
                        { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
                        pressed && { backgroundColor: c.surface2 },
                      ]}
                    >
                      <T style={{ fontSize: 15, color: c.faint }}>✕</T>
                    </Pressable>
                    {/* ★★这是 `/host` 唯一的入口了(见文件顶上 I1 的说明)—— iOS 那种「行尾 › 详情」
                        附件:行本身的点击**保留**给「切到这台」,这一颗单独负责「看这台的底细」
                        (令牌、对面版本、方法数、断开)。必须是自己的一颗 Pressable、自己的 ≥44pt
                        方框,不是 `hitSlop`——祖先(这一行的外层 Pressable)紧贴着它,hitSlop 在
                        Fabric 下是死的(`overflowInset`),真长出来的只有 `width`/`height`。
                        ★★只在**当前连着**这一行画它(`active && st.tone === 'ok'`,和上面
                        「已连接」pill 同一个判断)—— `/host` 讲的是当前连着的那一台
                        (见 `app/host.tsx` 顶部 JSDoc),不是「点了哪一行就讲哪一台」。给没连着
                        的行也画一颗 ›,点下去落地的却是**别的**行的底细(还带断开键、带令牌),
                        那是一颗说谎的控件,标题栏事后能认出走错了地方不算数。别的行没有这颗键
                        不是漏了,是它们目前没有能诚实指向自己的地方——要看,先切过去。 */}
                    {isCurrent ? (
                      <Pressable
                        onPress={() => router.push(ROUTES.host)}
                        accessibilityLabel={`${h.label} 详情`}
                        style={({ pressed }) => [
                          { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
                          pressed && { backgroundColor: c.surface2 },
                        ]}
                      >
                        <Icon name="chevron" size={15} color={c.faint} />
                      </Pressable>
                    ) : null}
                  </Row>
                )
              })}
            </List>
          </>
        )}

        <View style={{ height: 16 }} />
        <List>
          <Btn kind="ghost" block onPress={() => router.push(ROUTES.addHost)}>
            添加主机
          </Btn>
          {state?.status === 'failed' || state?.status === 'retrying' ? (
            <Btn block onPress={reconnect}>
              重新连接
            </Btn>
          ) : null}
        </List>

        {/* ★「这台机器提供 N 个方法」原来在这儿,已经搬走了 —— 它是**一台机器的底细**,
            和这一屏(清单:有哪几台、切哪台、删哪台)不是一件事,而且埋在列表最底下
            没人会滚到。现在它在两个真会去看的地方:设置 → 关于,以及 `app/host.tsx`
            (上面每一行末尾那颗 › 详情键推过去的那一屏)。
            ★★这条路一度断过:设置屏里那个「点当前主机进详情」的入口被这次改造删掉了,
            而它是当年**唯一**推 `/host` 的地方 —— 全仓库 grep 一遍 `/host` 只剩路由常量本身。
            现在的入口就是上面那颗 › 键,不是设置屏。
            这里不留第三份 —— 同一个数字抄三遍,迟早有一遍说的是另一台机器的。 */}
        {/* ★★「长按改名」必须写出来:长按是**看不见**的手势,不说的话这条功能等于没做。
            和上面那句合成一条,不另起一段 —— 这一屏的小字已经够多了。 */}
        <Note>切过去之后,会话、变更、终端全部换成那台机器的。不做同屏对比。长按一行可以改名字和图标 —— 当前连着的那台,进详情也能改。</Note>
      </ScrollView>

      {/* 长按一行呼出的编辑单子。★组件是三处共用的那一个(详情页、换主机单子、这儿)。 */}
      <HostEditSheet
        target={edit}
        onClose={() => setEdit(null)}
        onSave={(id, patch) => updateHost(id, patch)}
      />
    </View>
  )
}
