import { useCallback, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { Btn, IconBtn, List, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { confirmDestructive } from '../src/ui/confirmDestructive'
import { useConn } from '../src/net/conn'
// ★存储读写**一律走 localData**,这一屏不直接碰 AsyncStorage —— 理由见 `removeLocalKey` 的注释。
import { clearLocalData, removeLocalKey, sizesOf } from '../src/data/localData'
import { humanSize, STORAGE_ITEMS } from '../src/data/storageItems'

/**
 * 缓存管理。
 *
 * ★★为什么不是设置屏底下那颗「清除本地数据」红按钮:那颗按钮只有一个档位 —— 全清,
 *  而全清意味着**重新扫码配对**。想把字号调回默认的人,不该被迫连主机一起删掉。
 *  (2026-09-17 用户:「你放到一个设置里,叫缓存管理,你能把数据列出来么?然后用户可以选择性删除」)
 *
 * ★一键全清**保留**在最底下:它是「手机要借出去/卖掉」那个场景,和逐项删是两件事。
 *  它走的仍然是 `clearLocalData()` 的**按前缀扫**,不是把上面那张表循环一遍 ——
 *  表漏了某个 key 的话,循环版本会漏清,而按前缀扫不会(理由见 `localData.ts` 顶部)。
 */
export default function Storage() {
  const c = useC()
  const { forgetAll } = useConn()
  const [sizes, setSizes] = useState<Record<string, number> | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    // ★没存过的 key 记 0 而不是跳过 —— 那一行仍然要列出来,否则列表会随着用过哪些功能
    //  变长变短,人会以为「少了一项」是出了问题。
    setSizes(await sizesOf(STORAGE_ITEMS.map((i) => i.key)))
  }, [])

  // ★每次回到这一屏都重新量:删完一项返回、或者在别处改了设置,数字不刷新就是在骗人。
  useFocusEffect(useCallback(() => { void load() }, [load]))

  const removeOne = async (key: string, label: string, reconnect?: boolean) => {
    const ok = await confirmDestructive({
      title: `删除「${label}」?`,
      message: reconnect ? '所有主机和令牌都会删掉,之后要重新扫码配对。' : '会回到默认状态。',
      confirmLabel: '删除',
    })
    if (!ok) return
    setBusy(true)
    try {
      await removeLocalKey(key)
      // ★主机那一项删掉之后必须把内存里那份也忘掉,否则界面上还挂着一台已经不存在的主机。
      if (reconnect) forgetAll()
      await load()
    } finally { setBusy(false) }
  }

  const wipeAll = async () => {
    const ok = await confirmDestructive({
      title: '清除全部本地数据?',
      message: '主机、令牌、偏好设置全部删掉,要重新扫码配对。',
      confirmLabel: '全部清除',
    })
    if (!ok) return
    setBusy(true)
    try {
      await clearLocalData()
      forgetAll()
      await load()
    } finally { setBusy(false) }
  }

  const total = sizes ? Object.values(sizes).reduce((a, b) => a + b, 0) : 0

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="缓存管理" />
      </TopBar>

      <ScrollView contentContainerStyle={{ paddingBottom: 44 }}>
        <Sec>{sizes ? `共 ${humanSize(total)}` : ' '}</Sec>
        <List>
          {STORAGE_ITEMS.map((it) => (
            <Row key={it.key}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <T style={{ fontSize: 15, color: c.fg }}>{it.label}</T>
                <T numberOfLines={2} style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 3 }}>
                  {it.effect}
                </T>
              </View>
              <T mono style={{ fontSize: 12.5, color: c.faint, marginRight: 10 }}>
                {sizes ? humanSize(sizes[it.key] ?? 0) : '…'}
              </T>
              {/* ★空的那一项按钮置灰:删一个 0 字节的东西没有意义,而让它亮着等于承诺有事发生。 */}
              <Btn size="sm" kind={it.reconnect ? 'danger' : 'default'}
                disabled={busy || !sizes || !sizes[it.key]}
                onPress={() => void removeOne(it.key, it.label, it.reconnect)}>
                删除
              </Btn>
            </Row>
          ))}
        </List>

        {/* ★设计文档 §7.2:danger 不与主动作相邻。这段空白就是让手指够不着。 */}
        <View style={{ height: 28 }} />
        <List>
          <Btn kind="danger" block disabled={busy} onPress={() => void wipeAll()}>
            全部清除
          </Btn>
        </List>
      </ScrollView>
    </View>
  )
}
