import { Pressable, View } from 'react-native'
import { useC } from '../theme/theme'
import { T } from './kit'
import { Icon } from './Icon'
import { DEFAULT_HOST_ICON } from '../net/hosts'
import { StatusBadge } from './StatusBadge'
import { hostBannerDetail, hostBannerTitle } from '../net/hostStatusText'
import type { HostState } from '../net/hostClient'

/**
 * 顶栏那条主机横幅。**整条可点 —— 点开就换主机。**
 *
 * ★★2026-08-28 从两行压成一行。原来是「主机名」+「192.168.1.7:7777 · v1.2.0」两行;
 *  用户指着微信那条「Mac 微信已登录」说这块可以照着做。他是对的 —— 一切正常的时候,
 *  地址和版本一个字都不解决问题。所以第二行只在**出事**时出现(见 `hostBannerDetail`)。
 *
 * ★它**不只是状态,它是切换器**。这也是当初把主机放进顶栏、而不是做成微信那种
 *  「跟着列表滚走的横幅」的理由:切主机是个真会做的动作,不该埋在两层菜单底下;
 *  而且「滚到哪儿都看得见还有几道门」是这一屏的硬原则,跟着滚走的横幅做不到。
 *
 * ★门徽章常驻,而且**绝不让位**:主机名 `numberOfLines={1}` + `flexShrink` 先缩。
 *  一个长主机名叠上「大」字号把徽章顶出屏幕,就是「有门却看不见」——
 *  那是整个 app 存在的理由本身。
 */
export function HostBanner({
  label, icon, url, state, gateCount, onPress,
}: {
  label: string
  /**
   * 这台主机的图标(一个 emoji)。★空串 = 用默认那枚。
   *
   * ★★2026-09-03 之前这儿画的是一枚**写死的**通用主机字形,所以用户改了图标之后
   *  「名字变了、图标没变」—— 而真相是这儿从来就没有过他那枚图标。同一枚图标在
   *  主机列表、主机详情、换主机单子三处都是对的,唯独最显眼的这条横幅漏了。
   */
  icon: string
  url: string
  state: HostState | null
  /** 当前这台主机上挂着的门数。★和底部「会话」那格的角标**同源**,两处不许各算各的。 */
  gateCount: number
  onPress: () => void
}) {
  const c = useC()
  const ok = state?.status === 'ready'
  const wait = state?.status === 'connecting'
  // ★连上时不给标题上色 —— 一切正常的时候,那行字不该在视觉上叫人。
  //  出事时才染色:横幅的标题本来就直说「连不上 / 连接中…」,颜色是同一句话的第二遍。
  //  ★这条以前挂在图标上,现在图标换成了用户自己选的 emoji(emoji 染不了色),
  //   所以信号移到文字上。信息没丢,只是换了个载体。
  const tint = ok ? c.fg : wait ? c.warn : c.err
  const detail = hostBannerDetail(url, state)
  return (
    <Pressable
      onPress={onPress}
      // 整条都是热区,而不是只有那几个字可点 —— 这套代码已经在别处栽过
      // 「点了没反应,其实点在旁边的空白上」。★用 padding 撑,不用 hitSlop:
      // hitSlop 在祖先紧贴子节点时是死的(Fabric 的 overflowInset)。
      // ★★★`minHeight: 44`:连上时(最常见的那个状态)`hostBannerDetail` 返回 null,
      // 只剩一行文字 + 8px padding ≈ 28pt —— 够不上这份计划定死的 44pt 最小热区。
      // 这条计划里 hitSlop 被明令禁止(祖先紧贴子节点时它是死的,Fabric 的 overflowInset,
      // 这个仓库已经栽过一次:一颗「复制」按钮缩成 22×13pt 死区,被当成剪贴板坏了整整一轮测试)。
      // 断线时 detail 那一行会把内容撑得比 44 更高,minHeight 那时候不起作用,不冲突。
      style={({ pressed }) => [
        { paddingHorizontal: 2, paddingVertical: 4, minHeight: 44, justifyContent: 'center' as const },
        pressed && { opacity: 0.6 },
      ]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        {/* 用户自己选的那枚图标。★和主机列表/详情/切换单子用的是同一个字段,
            不是这儿另画一个 —— 「同一台机器在两屏上长得不一样」没人会当 bug 报,
            只会觉得这个 app 做得糙。 */}
        <T style={{ fontSize: 15 }}>{icon || DEFAULT_HOST_ICON}</T>
        <T
          numberOfLines={1}
          style={{ fontSize: 15.5, fontWeight: '600', letterSpacing: -0.3, color: tint, flexShrink: 1, minWidth: 0 }}
        >
          {hostBannerTitle(label, state)}
        </T>
        {/* ▾ 是「这儿能点开」的唯一信号。手机上没有 hover,不画它就没人知道这条是活的。 */}
        <Icon name="chevronDown" size={10} color={c.faint} />
        {gateCount > 0 ? (
          <View style={{ marginLeft: 'auto' }}>
            <StatusBadge tier="gate" count={gateCount} />
          </View>
        ) : null}
      </View>
      {/* ★★判 null 才渲染。`hostBannerDetail` 连上时返回 null 正是为了这一行 ——
          返回空串的话这里会渲染出一个高度不为 0 的空 `<T>`,顶栏平白高一截。 */}
      {detail !== null ? (
        <T numberOfLines={1} mono style={{ fontSize: 11.5, color: ok ? c.muted : c.err, marginTop: 1 }}>
          {detail}
        </T>
      ) : null}
    </Pressable>
  )
}
