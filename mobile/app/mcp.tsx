import { useCallback, useEffect, useState } from 'react'
import { ScrollView, View } from 'react-native'
import { goBack } from '../src/nav'
import { CH } from '../../src/main/ipc/channels'
import { MCP_AUTH_LABEL, type McpProviderView } from '../../src/shared/mcp'
import { useC } from '../src/theme/theme'
import { Empty, IconBtn, List, Note, Row, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { useStore } from '../src/data/store'

/**
 * MCP 服务器 —— **只读**。
 *
 * ★用户当时的原话是「手机能看就行,授权不用」。所以这一屏刻意不摆授权按钮:
 *  授权要么在主机上开浏览器,要么得把回调地址粘回来,两条在手机上都不是顺手的事;
 *  而「我配的那台 MCP 到底连上没有」是随时想查一眼的 —— 这一屏答的是后者。
 * ★列的是**那台主机**上各 CLI 的配置。带上当前会话的工作区目录:项目级(.mcp.json)的
 *  服务器只有在那个目录里跑命令才看得见。
 */
export default function McpScreen() {
  const c = useC()
  const { invoke, online, methods } = useConn()
  const { selected, wsName } = useStore()
  const [rows, setRows] = useState<McpProviderView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const supported = methods.has(CH.mcpOverview)

  const load = useCallback(async () => {
    if (!online || !supported) return
    setErr(null)
    try {
      setRows((await invoke(CH.mcpOverview, [{ workspacePath: selected?.wsPath }])) as McpProviderView[])
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [invoke, online, supported, selected])

  useEffect(() => { void load() }, [load])

  const tone = (a: string) =>
    a === 'connected' ? c.ok : a === 'needs-auth' ? c.gate : a === 'failed' ? c.err : c.muted

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="MCP 服务器" sub={selected ? wsName(selected.wsPath) : '这台主机'} />
      </TopBar>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {!online ? (
          <Empty title="未连接" desc="MCP 配在那台机器上,连上才看得到。" />
        ) : !supported ? (
          // 决策 B-2:老主机没有这条方法。明说原因,别摆一个永远空着的列表。
          <Empty title="这台主机不支持" desc="那台机器上的 myFlowForge 还是旧版,升级之后这里才有内容。" />
        ) : err ? (
          <Empty title="读不到" desc={err} />
        ) : rows === null ? (
          <Empty title="正在问各个 CLI…" />
        ) : (
          <>
            {rows.filter((r) => r.caps.mcp).map((r) => (
              <View key={r.providerId}>
                <Sec right={<T mono style={{ fontSize: 10.5, color: c.faint }}>{r.servers.length}</T>}>{r.displayName}</Sec>
                {r.error ? (
                  <Note>{r.error}</Note>
                ) : r.servers.length === 0 ? (
                  <Note>还没配 MCP 服务器。</Note>
                ) : (
                  <List>
                    {r.servers.map((s) => (
                      <Row key={s.name}>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <T style={{ fontSize: 14.5, fontWeight: '600', color: c.fg }}>{s.name}</T>
                          <T mono numberOfLines={1} style={{ fontSize: 11, color: c.muted, marginTop: 3 }}>{s.target}</T>
                        </View>
                        {/* ★状态旁边把 CLI 原话也带上(小字):我们的映射猜错了,至少屏幕上还有真话。 */}
                        <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
                          <T style={{ fontSize: 12, color: tone(s.auth) }}>{MCP_AUTH_LABEL[s.auth]}</T>
                          {s.detail ? <T mono numberOfLines={1} style={{ fontSize: 9.5, color: c.faint, marginTop: 2 }}>{s.detail}</T> : null}
                        </View>
                      </Row>
                    ))}
                  </List>
                )}
              </View>
            ))}
            {rows.filter((r) => r.caps.mcp).length === 0 ? (
              <Empty title="没有可看的" desc="这台主机上装着的 CLI 都没有 mcp 子命令。" />
            ) : null}
            <Note>只读。要授权、要加服务器,去电脑端(聊天里打 /mcp,或者设置 → 代理)。</Note>
          </>
        )}
      </ScrollView>
    </View>
  )
}
