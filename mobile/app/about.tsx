import { ScrollView, View } from 'react-native'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { CLIENT_VERSION, useConn } from '../src/net/conn'
import { aboutRows } from '../src/ui/aboutRows'

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
        <TopTitle title="关于" sub="连不上的时候,先看这三个数" />
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
        <Note>
          两端主版本号必须一致才连得上;方法对不上的功能会在界面上置灰,而不是点下去报一句看不懂的错。
        </Note>

        {/* ★这一段不是介绍词,是**这个 app 是什么**那句话。手机端不在本地跑代理,
            它是电脑上那台 Forge 的遥控器 —— 不写清楚的话,「为什么关掉电脑就什么都没了」
            会变成一个 bug 报告。 */}
        <Sec>这是什么</Sec>
        <Note>
          myFlowForge 手机端是你电脑上那台 Forge 的遥控器:代理、工作区、会话全都在那台电脑上跑,
          这台手机只负责看见和答话。所以电脑睡了、daemon 停了,这里就什么都没有 —— 那不是坏了。
        </Note>
      </ScrollView>
    </View>
  )
}
