import { useState } from 'react'
import { ROUTES } from '../src/nav/routes'
import { ScrollView, View } from 'react-native'
import { goBack, goToHosts } from '../src/nav'
import { useC } from '../src/theme/theme'
import { Btn, Empty, IconBtn, List, LiveDot, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { describeHostState } from '../src/net/hostStatusText'
import { maskToken } from '../src/net/tokenMask'
import { HostIcon } from '../src/ui/HostIcon'
import { CAN_COPY, CopyBtn } from '../src/ui/CopyBtn'

/**
 * **当前这台主机的配置**。入口是「主机」tab 里当前连着那一行末尾的 › 键
 * (`app/(tabs)/hosts.tsx`);设置屏那条路已经删了,别再照旧写法说是从设置屏进来的。
 *
 * ★为什么另开一屏而不是塞进设置或复用 `/hosts`:三者管的是三件不同的事,合在一起谁也说不清。
 *  - `/hosts` 是**清单**:有哪几台、切哪台、删哪台、加一台。它一台机器只占一行,放不下细节。
 *  - `/settings` 是**这台手机**的偏好(外观、字号、清数据),主机在那儿只是一行状态。
 *  - 这一屏是**一台机器的底细**:地址、令牌、对面版本、它认得多少个方法。
 *    这四样正是「功能怎么突然不见了 / 为什么连不上」唯一能查的东西,而在这次改之前
 *    它们要么根本不在界面上(令牌从填进去那一刻起就再也看不见了),
 *    要么埋在 `/hosts` 底部一句谁也不会滚到的小字里(方法数)。
 *
 * ★这一屏只讲**当前连着的**那一台。别的主机没有连接状态、没有版本、没有方法表 ——
 *  给它们画一屏同样的框、里面四行「未知」,那是四行噪音。要看别的,先切过去。
 */
export default function Host() {
  const c = useC()
  const { activeHost, state, methods, selectHost, reconnect } = useConn()
  // 令牌默认遮住。★不是防偷看,是防**截图和投屏** —— 排查连接问题的时候人最爱干的就是截个图发出来。
  const [showToken, setShowToken] = useState(false)

  if (!activeHost) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
          <TopTitle title="主机" />
        </TopBar>
        <Empty title="现在没连着任何主机" desc="这一屏讲的是当前这台机器的底细,先连上一台。" />
        <View style={{ paddingHorizontal: 30 }}>
          {/* ★不是 `router.push(ROUTES.hosts)`:`/hosts` 现在是 `(tabs)` 里的一格,不是根栈的一层 ——
              直接 push 会把整个 `(tabs)` 分组再压一份进根栈,和 `goToHosts()` 当初要避免的
              那类栈损坏是同一个错法(见 `src/nav.ts` 的 JSDoc)。 */}
          <Btn kind="ghost" block onPress={() => goToHosts()}>
            管理主机
          </Btn>
        </View>
      </View>
    )
  }

  const d = describeHostState(state)
  const ready = state?.status === 'ready'
  const addr = activeHost.url.replace(/^wss?:\/\//, '')

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title={activeHost.label} sub={addr} />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        <Sec>连接</Sec>
        <List>
          <Row>
            <HostIcon icon={activeHost.icon} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 12, color: c.muted }}>状态</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                <LiveDot tone={d.tone === 'idle' ? 'off' : d.tone} />
                {/* 断线时这一行报的是**为什么**(退避秒数 / 失败原因),不是一句「未连接」。
                    和设置屏、主机屏共用 `describeHostState` 那一份实现。 */}
                <T numberOfLines={2} style={{ fontSize: 13, color: c.fg, flexShrink: 1, minWidth: 0 }}>
                  {d.text}
                </T>
              </View>
            </View>
          </Row>
          <Row>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 12, color: c.muted }}>地址</T>
              <T mono numberOfLines={1} style={{ fontSize: 13.5, color: c.fg, marginTop: 3 }}>
                {addr}
              </T>
            </View>
            {/* 探测不到剪贴板就**根本不摆这两个字**(见 CopyBtn 顶部:上一次是「按钮照常显示、点下去当场崩」)。 */}
            {CAN_COPY ? <CopyBtn text={addr} /> : null}
          </Row>
          <Row>
            <View style={{ flex: 1, minWidth: 0 }}>
              <T style={{ fontSize: 12, color: c.muted }}>令牌</T>
              <T mono numberOfLines={2} style={{ fontSize: 13.5, color: activeHost.token ? c.fg : c.faint, marginTop: 3 }}>
                {/* 没令牌是**正常的一档**(绑回环的 daemon 不要令牌),所以说出来,
                    而不是留一片空白让人以为是没读出来。 */}
                {!activeHost.token ? '这台主机不要令牌' : showToken ? activeHost.token : maskToken(activeHost.token)}
              </T>
            </View>
            {activeHost.token ? (
              <Btn size="sm" onPress={() => setShowToken((v) => !v)}>
                {showToken ? '隐藏' : '显示'}
              </Btn>
            ) : null}
            {/* ★复制只在**已经显示出来**的时候给。遮着的时候给一颗复制键,等于遮罩根本不存在。 */}
            {activeHost.token && showToken && CAN_COPY ? <CopyBtn text={activeHost.token} /> : null}
          </Row>
        </List>
        <Note>
          令牌等于这台电脑上 agent 和终端的控制权。它只存在这台手机上,换手机要重新扫码配对。
        </Note>

        <Sec>这台机器提供</Sec>
        <List>
          <Row>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>版本</T>
            <T mono style={{ fontSize: 13, color: ready ? c.muted : c.faint }}>
              {/* 版本只有连上了才知道 —— 断着的时候写上一次的值就是在骗人(对面可能已经升级过了)。 */}
              {ready ? state.version : '连上才知道'}
            </T>
          </Row>
          <Row>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>方法数</T>
            <T mono style={{ fontSize: 13, color: ready ? c.muted : c.faint }}>
              {ready ? `${methods.size} 个` : '连上才知道'}
            </T>
          </Row>
        </List>
        {/* ★这句话原来埋在 `/hosts` 最底下。它解释的是一个真会遇到的现象:
            对面版本旧 → 某个功能整个置灰。没有这句话,置灰看起来就是 app 坏了。 */}
        <Note>对不上的功能会在界面上置灰,而不是点下去报一句看不懂的错。</Note>

        <View style={{ height: 20 }} />
        <List>
          {state?.status === 'failed' || state?.status === 'retrying' ? (
            <Btn block onPress={reconnect}>
              重新连接
            </Btn>
          ) : null}
          {/* ★danger 不与主动作相邻(设计文档 §7.6)—— 上面那段空隙就是唯一目的。
              断开只是不连了,主机和令牌都还留着:那是「删除主机」的活,在 /hosts 那一屏。 */}
          <Btn
            kind="danger"
            block
            onPress={() => {
              void selectHost(null)
              goBack()
            }}
          >
            断开
          </Btn>
        </List>
      </ScrollView>
    </View>
  )
}
