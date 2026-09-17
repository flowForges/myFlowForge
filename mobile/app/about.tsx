import { Linking, ScrollView, View } from 'react-native'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { CLIENT_VERSION, useConn } from '../src/net/conn'
import { aboutRows } from '../src/ui/aboutRows'
// ★域名**只有一处真相**(`src/shared/links.ts`),电脑端用的是同一份 —— 手机上手写一遍,
//  换域名的那天就会有一端悄悄指向旧地址。
import { docsUrl, SITE_HOST, SITE_ORIGIN } from '../../src/shared/links'

/**
 * 关于。设置屏里那一行「关于」点进来的就是这里 —— 和主机那一行推 `app/host.tsx` 是同一条路数。
 *
 * ★为什么从设置里搬出来单独一屏:它原来是设置屏中间的一组**内联行**,夹在「外观」和「这台手机」
 *  之间。而设置屏的分组头是那一屏唯一的结构信号,一组三行死数据摆在两组**能改的东西**中间,
 *  读起来像「这三样也是设置」——可它们一个都点不动。搬出来之后设置屏只剩「能改的」,
 *  这三个数则有了自己的地方,不用再挤在一列 `Row` 里。
 *
 * ★★内容只有**真有的东西**:两端版本 + 方法数。没有官网、没有更新日志、没有开源许可页 ——
 *  这个 app 里都不存在,摆一条点了没反应的链接比不摆糟得多。
 *  这三个数为什么值得凑一屏,以及断线时为什么必须写「连上才知道」而不是留旧值,
 *  都在 `src/ui/aboutRows.ts` 上(那份逻辑在 node 下有单测)。
 *
 * ★**没连主机也必须进得来**:这一屏是「我这台手机是哪个版本」的唯一出处,
 *  而问这个问题的时候多半正是连不上的时候。顶上绝不能写 `if (!online) return`。
 */
export default function About() {
  const c = useC()
  const { state, methods } = useConn()
  const ready = state?.status === 'ready'
  // ★版本从 `CLIENT_VERSION`(→ `app.json`)来,不在这一屏写死:
  //  写死的那份和握手时报上去的那个迟早对不上,界面写着一个数、握手报的是另一个。
  const rows = aboutRows({
    clientVersion: CLIENT_VERSION,
    host: ready ? { version: state.version, methods: methods.size } : null,
  })

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="关于" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        <Sec>版本</Sec>
        <List>
          {rows.map((r) => (
            <Row key={r.label}>
              <T style={{ flex: 1, fontSize: 15, color: c.fg }}>{r.label}</T>
              {/* ★占位文字画淡:「连上才知道」和一个真版本号长得一样重的话,
                  扫一眼会以为对面报了这么个东西。 */}
              <T mono numberOfLines={1} style={{ fontSize: 13, color: r.known ? c.muted : c.faint, flexShrink: 1, minWidth: 0 }}>
                {r.value}
              </T>
            </Row>
          ))}
        </List>

        {/* ★★2026-09-17:这里原来是两段说明(版本怎么对、这个 app 是什么)。都删了 ——
            用户原话:「里面底下一堆描述文字,都没用」。
            ★而它们想说的东西没有丢:官网上写得比这儿全,所以这里改成**一个能点开的入口**。
            一行链接 vs 两段没人读的字,前者还真的把人送到了答案那边。 */}
        <Sec>myFlowForge</Sec>
        <List>
          <Row onPress={() => { void Linking.openURL(SITE_ORIGIN).catch(() => {}) }}>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>官网</T>
            <T mono numberOfLines={1} style={{ fontSize: 12.5, color: c.muted, flexShrink: 1, minWidth: 0 }}>{SITE_HOST}</T>
            <T style={{ fontSize: 16, color: c.faint, marginLeft: 8 }}>›</T>
          </Row>
          <Row onPress={() => { void Linking.openURL(docsUrl()).catch(() => {}) }}>
            <T style={{ flex: 1, fontSize: 15, color: c.fg }}>使用文档</T>
            <T style={{ fontSize: 16, color: c.faint }}>›</T>
          </Row>
        </List>
      </ScrollView>
    </View>
  )
}
