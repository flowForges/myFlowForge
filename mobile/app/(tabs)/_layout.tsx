import { Tabs } from 'expo-router'
import { useC } from '../../src/theme/theme'
import { Icon } from '../../src/ui/Icon'
import { useStore } from '../../src/data/store'
import { useConn } from '../../src/net/conn'
import { tap } from '../../src/ui/haptics'

/**
 * 底部三格。
 *
 * ★★为什么是三格、而且「＋ 新建」**不在**里面:tab 的每一格必须是一个能停留的
 *  destination。「新建工作区」是一个**动作** —— 点了弹流程、做完回原地,它永远不会处于
 *  选中态,那一格会一直是灰的。它放**顶栏右上角**(见 Task 5 的 HostBanner),
 *  微信的「发起群聊 / 添加朋友」也在右上角的 ＋ 里,从来不在底栏。
 *
 * ★★2026-09-02:中间那格从「主机」换成了「工作区」。理由见下面那段注释 —— 一句话:
 *  主机是**配一次**的东西,工作区是**每天都在动**的东西,而 tab 的位置该给后者。
 *
 * ★会话那格的角标 = **当前主机上挂着的门数**,和顶栏横幅那个徽章**同源**(都读 `gates.length`)。
 *  两处各算各的话,迟早出现「顶上说 3 道门、底下角标写 2」这种自己打自己脸的画面。
 *  不算未读:未读是「跑完了你没看」,门是「代理停在那儿等你」—— 后者才值得占一个角标。
 *
 * ★★没连上时角标也要跟着收起来:`gates` 是断线前留在内存里的旧数据(第一版不缓存正文,
 *  但没专门清这个数组),不判 `online` 的话断线那一刻会一边显示「未连接」一边挂着一枚门角标,
 *  两处同时说反话。和 `app/(tabs)/index.tsx` 里 `HostBanner` 的 `gateCount` 同一条件。
 *
 * ★次级屏(对话/变更/工作流/新建工作区/添加主机/扫码…)全在**根栈**里,推出去时天然盖住
 *  这条 tab bar,不需要一屏一屏去关 —— 见 `app/_layout.tsx`。
 */
export default function TabLayout() {
  const c = useC()
  const { gates } = useStore()
  const { online } = useConn()
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.faint,
        tabBarStyle: { backgroundColor: c.surface2, borderTopColor: c.border },
        tabBarLabelStyle: { fontSize: 10, letterSpacing: 0.2 },
        // 门那个角标用琥珀,和全 app 的门色一致(绝不用系统默认的红 —— 红在这套配色里是「出错」)。
        tabBarBadgeStyle: { backgroundColor: c.gate, color: c.onGate, fontSize: 10, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '会话',
          tabBarIcon: ({ color }) => <Icon name="chat" size={20} color={color as string} />,
          tabBarBadge: online && gates.length > 0 ? gates.length : undefined,
        }}
        // 切 tab 是「有分量」的切换动作(selection 档),不是普通点击。三格都接同一条,
        // 免得漏一格 —— 漏的那格摸起来会跟另外两格不一致。
        listeners={{ tabPress: () => tap('switchTab') }}
      />
      {/* ★★2026-09-02:这一格原来是「主机」。用户原话「感觉有点浪费」—— 确实:那一屏全是
          配对时用一次就再不碰的事(列表/添加/删除/改名),而「现在连着哪台 + 快切」
          首页顶栏的 HostBanner 早就在做。主机退回**设置里的一行**,这一格给工作区。
          ★工作区**是**一个能停留的 destination(有哪些区、什么状况、置顶/改名/归档/新建/已归档),
          而这些原来散在三处:首页一颗 ＋、首页看不见的长按左滑、以及**设置里**的「已归档」。 */}
      <Tabs.Screen
        name="workspaces"
        options={{
          title: '工作区',
          tabBarIcon: ({ color }) => <Icon name="folder" size={20} color={color as string} />,
        }}
        listeners={{ tabPress: () => tap('switchTab') }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ color }) => <Icon name="settings" size={20} color={color as string} />,
        }}
        listeners={{ tabPress: () => tap('switchTab') }}
      />
    </Tabs>
  )
}
