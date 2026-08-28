import { Pressable, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useC } from '../../src/theme/theme'
import { Btn, Empty, List, LiveDot, Note, Pill, Row, Sec, T, TopBar, TopTitle } from '../../src/ui/kit'
import { useConn } from '../../src/net/conn'
import { type MobileHost } from '../../src/net/hosts'
import { useStore } from '../../src/data/store'
// 一句人话的连接状态。★这一份和设置屏共用同一个实现,别在任何一边抄第二遍 —— 见该文件注释。
import { describeHostState, hostSubtitle } from '../../src/net/hostStatusText'
import { HostIcon } from '../../src/ui/HostIcon'
// ★web/native 那条确认框分支收在这一个函数里,原地各写一遍的历史(这里 + archiveWs +
//  confirmDeleteSession)已经收掉了,见它的 JSDoc。
import { confirmDestructive } from '../../src/ui/confirmDestructive'

export default function Hosts() {
  const c = useC()
  const { hosts, activeHost, state, selectHost, removeHost, reconnect } = useConn()
  const { gates } = useStore()

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
      {/* ★2026-08-29:没有 `‹` 了 —— 这一屏现在是底部 tab 的一格,不是被推进来的次级屏。
          tab 没有「上一层」,留着箭头会变成一颗「点了会跳到别的 tab」的假返回键。 */}
      <TopBar>
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
                return (
                  <Row key={h.id} onPress={() => void selectHost(h.id)}>
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
                    ) : active && st.tone === 'ok' ? (
                      <Pill tone="run">已连接</Pill>
                    ) : null}
                    <Pressable onPress={() => remove(h)} hitSlop={10} style={{ paddingHorizontal: 4 }}>
                      <T style={{ fontSize: 15, color: c.faint }}>✕</T>
                    </Pressable>
                  </Row>
                )
              })}
            </List>
          </>
        )}

        <View style={{ height: 16 }} />
        <List>
          <Btn kind="ghost" block onPress={() => router.push('/add-host')}>
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
            没人会滚到。现在它在两个真会去看的地方:设置 → 关于,以及 `app/host.tsx`。
            这里不留第三份 —— 同一个数字抄三遍,迟早有一遍说的是另一台机器的。 */}
        <Note>切过去之后,会话、变更、终端全部换成那台机器的。不做同屏对比。</Note>
      </ScrollView>
    </View>
  )
}
