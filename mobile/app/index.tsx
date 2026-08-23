import { Text, View } from 'react-native'
import { PROTOCOL_VERSION } from '../../src/shared/remote/protocol'
import { CH } from '../../src/main/ipc/channels'
import { useC } from '../src/theme/theme'
import { useConn } from '../src/net/conn'

export default function Home() {
  const c = useC()
  const { hosts, state } = useConn()
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: 20, gap: 8 }}>
      <Text style={{ color: c.fg, fontSize: 18 }}>myFlowForge 手机端</Text>
      <Text style={{ color: c.muted }}>协议版本 {PROTOCOL_VERSION} · 会话列表频道 {CH.sessionList}</Text>
      <Text style={{ color: c.muted }}>主机 {hosts.length} 台 · {state?.status ?? '未选主机'}</Text>
    </View>
  )
}
