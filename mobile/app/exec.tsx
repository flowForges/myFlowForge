import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import type { DiffLine } from '../../src/shared/types'
import { MONO, useC } from '../src/theme/theme'
import { Empty, IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'
import { useChanges } from '../src/data/useChanges'

/**
 * 执行面板 · 变更。
 *
 * 桌面端右栏是「概览 / 变更 / 文件树」三个 tab;手机端第一版只做**变更**,因为它是
 * 「敢不敢让它继续」的唯一依据 —— 门上按「允许」之前,你想看的是它到底改了什么。
 * 概览和文件树在手机上价值低得多,留到后面。
 *
 * ★整屏推入(右上角进,左上角返回),不是底部上滑 —— 原型 B 版被否掉的正是那个看不见的手势。
 */
export default function Exec() {
  const c = useC()
  const { online } = useConn()
  const { selected, wsName } = useStore()
  const { groups, total, loading, error, diff } = useChanges(selected?.wsPath ?? null)
  const [open, setOpen] = useState<{ cwd: string; file: string } | null>(null)
  const [lines, setLines] = useState<DiffLine[] | null>(null)
  const [diffErr, setDiffErr] = useState<string | null>(null)

  const openDiff = async (cwd: string, file: string) => {
    setOpen({ cwd, file })
    setLines(null)
    setDiffErr(null)
    try {
      setLines(await diff(cwd, file))
    } catch (e) {
      setDiffErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (open) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <TopBar left={<IconBtn onPress={() => setOpen(null)}>‹</IconBtn>}>
          <TopTitle title={open.file.split('/').pop() ?? open.file} sub={open.file} />
        </TopBar>
        <ScrollView horizontal contentContainerStyle={{ minWidth: '100%' }}>
          <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingBottom: 40 }}>
            {diffErr ? (
              <Empty title="读不到这个文件的 diff" desc={diffErr} />
            ) : !lines ? (
              <Empty title="正在读取…" />
            ) : lines.length === 0 ? (
              <Empty title="没有可显示的差异" />
            ) : (
              lines.map((l, i) => (
                <View
                  key={i}
                  style={[
                    st.line,
                    l.kind === 'add' ? { backgroundColor: c.addBg } : l.kind === 'del' ? { backgroundColor: c.delBg } : null,
                  ]}
                >
                  <T style={[st.ln, { color: c.faint }]}>{l.ln || ''}</T>
                  <T style={[st.code, { color: c.fg2 }]}>
                    {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                    {l.text}
                  </T>
                </View>
              ))
            )}
          </ScrollView>
        </ScrollView>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => (goBack())}>‹</IconBtn>}>
        <TopTitle
          title="变更"
          sub={selected ? `${wsName(selected.wsPath)} · ${total.total} 个文件 +${total.add} −${total.del}` : '未选会话'}
        />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {!online ? (
          <Empty title="未连接" desc="变更是现读的,连上才有。" />
        ) : !selected ? (
          <Empty title="先选一个会话" />
        ) : loading ? (
          <Empty title="正在读取…" />
        ) : error ? (
          <Empty title="读不到变更" desc={error} />
        ) : total.total === 0 ? (
          <Empty title="工作树是干净的" desc="代理还没动过文件,或者改动已经提交了。" />
        ) : (
          groups
            .filter((g) => g.changes.length > 0)
            .map((g) => (
              <View key={g.cwd}>
                <Sec
                  right={
                    <T mono style={{ fontSize: 10.5, color: c.faint }}>
                      {g.changes.length} 个文件
                    </T>
                  }
                >
                  {g.name}
                </Sec>
                <List>
                  {g.changes.map((ch) => (
                    <Row key={ch.path} onPress={() => void openDiff(g.cwd, ch.path)}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T numberOfLines={1} mono style={{ fontSize: 12.5, color: c.fg }}>
                          {ch.path}
                        </T>
                      </View>
                      <T mono style={{ fontSize: 11.5, color: c.add }}>
                        +{ch.add}
                      </T>
                      <T mono style={{ fontSize: 11.5, color: c.del }}>
                        −{ch.del}
                      </T>
                    </Row>
                  ))}
                </List>
              </View>
            ))
        )}
        <Note>只读。手机上不提交、不回滚 —— 那些留在电脑端。</Note>
      </ScrollView>
    </View>
  )
}

const st = StyleSheet.create({
  line: { flexDirection: 'row', paddingHorizontal: 4 },
  ln: { width: 44, textAlign: 'right', paddingRight: 9, fontFamily: MONO, fontSize: 11.5, lineHeight: 20 },
  code: { fontFamily: MONO, fontSize: 11.5, lineHeight: 20, paddingRight: 12 },
})
