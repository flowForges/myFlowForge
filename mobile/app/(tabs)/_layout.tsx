import { Tabs } from 'expo-router'
import { useC } from '../../src/theme/theme'
import { Icon } from '../../src/ui/Icon'
import { useStore } from '../../src/data/store'

/**
 * 底部三格。
 *
 * ★★为什么是三格、而且「＋ 新建」**不在**里面:tab 的每一格必须是一个能停留的
 *  destination。「新建工作区」是一个**动作** —— 点了弹流程、做完回原地,它永远不会处于
 *  选中态,那一格会一直是灰的。它放**顶栏右上角**(见 Task 5 的 HostBanner),
 *  微信的「发起群聊 / 添加朋友」也在右上角的 ＋ 里,从来不在底栏。
 *
 * ★为什么「主机」单独一格:它原来埋在「设置 → 主机」底下。顶栏那条横幅是**状态 + 快切**
 *  (跟微信「Mac 微信已登录」同一个性质),这一格是**管理**(列表、添加、配对、删除)。
 *  微信也正是这么分的,两者不重复。
 *
 * ★会话那格的角标 = **当前主机上挂着的门数**,和顶栏横幅那个徽章**同源**(都读 `gates.length`)。
 *  两处各算各的话,迟早出现「顶上说 3 道门、底下角标写 2」这种自己打自己脸的画面。
 *  不算未读:未读是「跑完了你没看」,门是「代理停在那儿等你」—— 后者才值得占一个角标。
 *
 * ★次级屏(对话/变更/工作流/新建工作区/添加主机/扫码…)全在**根栈**里,推出去时天然盖住
 *  这条 tab bar,不需要一屏一屏去关 —— 见 `app/_layout.tsx`。
 */
export default function TabLayout() {
  const c = useC()
  const { gates } = useStore()
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
          tabBarBadge: gates.length > 0 ? gates.length : undefined,
        }}
      />
      <Tabs.Screen
        name="hosts"
        options={{
          title: '主机',
          tabBarIcon: ({ color }) => <Icon name="host" size={20} color={color as string} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: '设置',
          tabBarIcon: ({ color }) => <Icon name="settings" size={20} color={color as string} />,
        }}
      />
    </Tabs>
  )
}
