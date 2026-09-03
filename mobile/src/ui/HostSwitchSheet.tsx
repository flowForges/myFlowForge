import { View } from 'react-native'
import { useC } from '../theme/theme'
import { Btn, Empty, LiveDot, Note, Row, T } from './kit'
import { Sheet } from './Sheet'
import { HostIcon } from './HostIcon'
import { StatusBadge } from './StatusBadge'
import type { HostPickRow } from '../net/hostPicker'

/**
 * 换主机那张单子 —— 列表页顶部主机条点开的就是它(设计文档 §4.4b)。
 *
 * ★**为什么切主机值得有一条常驻的入口**:它埋在「设置 → 主机 → 点一台」两层底下,
 *  而这是个真会做的动作(用户手里就有两台电脑)。顺带把「现在连的是哪台」摆成了常驻信息 ——
 *  用户之前当面问过「怎么确认对话是不是远程的」,说明这件事从来没被说清楚过。
 *
 * ★**两条来自 spec 的细节,别当装饰删掉**:
 *  ① 每台主机要看得出**上面有没有门在等**。不显示的话,你得先切过去才发现那边有事,
 *    而切过去这一下就把当前这台的上下文丢了(会话、工作区、运行全换)。
 *  ② 顶上那句话说清切换的**边界**。这是决策 8(client / host 分家)在界面上唯一的兑现:
 *    换的是那台电脑上的东西,外观和字号是你手上这台手机的,不会跟着变。
 *
 * ★★但门数**只有连着的那一台知道**(见 `hostPicker.ts` 的注释):没连上的那几台
 *  这里**什么也不画**,不画一个「0 门」。画 0 等于替它说「那边没事」,而那句话我们没资格说。
 *  这条约束下面用 `gates != null` 兑现 —— 写成 `gates > 0` 也能过,但 null 和 0 就混成一件事了。
 */
export function HostSwitchSheet({
  open,
  rows,
  onClose,
  onPick,
  onAddHost,
  onEdit,
}: {
  open: boolean
  rows: HostPickRow[]
  onClose: () => void
  onPick: (id: string) => void
  onAddHost: () => void
  /**
   * 长按一行 = 改它的名字和图标。★用户当场问的:「点击首页左上角的主机连接,会弹出一个
   * 主机列表和添加主机,为什么这里面不能修改主机名称和图标?」—— 这张单子的正业是**切换**,
   * 给每一行都摆一颗编辑键会把它的正业挤掉;长按零视觉成本,而且和设置里那份列表是同一个手势。
   * ★但长按是**看不见**的,所以底下那句 Note 必须写出来。这个仓库在这上面栽过一次。
   */
  onEdit: (id: string) => void
}) {
  const c = useC()
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="换一台主机"
      sub="切过去只换会话、工作区、运行。外观和字号跟着这台手机走,不会变。"
    >
      {rows.length === 0 ? <Empty title="还没有配过主机" desc="在电脑上跑起 daemon,把它打印的地址填进来。" /> : null}
      {rows.map((r) => (
        // 点即切。★不弹确认:切主机是可逆的(再点回来就行),而多一步确认会让
        //  「我到底连的哪台」这件事更难当场试出来。
        <Row
          key={r.id}
          onPress={() => onPick(r.id)}
          onLongPress={() => onEdit(r.id)}
          style={r.active ? { borderColor: c.accent, backgroundColor: c.accentDim } : undefined}
        >
          <HostIcon icon={r.icon} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T numberOfLines={1} style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>
              {r.label}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
              {r.tone ? <LiveDot tone={r.tone === 'idle' ? 'off' : r.tone} /> : null}
              <T numberOfLines={1} mono style={{ fontSize: 11.5, color: c.muted, flexShrink: 1, minWidth: 0 }}>
                {r.sub}
              </T>
            </View>
          </View>
          {/* 门徽章绝不让位 —— 左边那一坨会先被挤扁(flex:1 + minWidth:0)。 */}
          {r.gates != null && r.gates > 0 ? <StatusBadge tier="gate" count={r.gates} /> : null}
        </Row>
      ))}
      {/* ★这句话是上面「没连上的一律不画门徽章」的**说明**,不是客套话。
          没有它,一排干干净净的主机看起来就是「那几台都没事」—— 恰恰是我们没资格说的那句。 */}
      <Note>别的主机上有没有门在等,只有连上去才知道 —— 这里不猜。长按一行可以改它的名字和图标。</Note>
      <View style={{ height: 4 }} />
      <Btn kind="ghost" block onPress={onAddHost}>
        ＋ 添加主机
      </Btn>
    </Sheet>
  )
}
