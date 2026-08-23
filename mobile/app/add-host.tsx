import { useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { router } from 'expo-router'
import { useC } from '../src/theme/theme'
import { Btn, Field, IconBtn, List, Note, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { isLoopbackUrl, parseAddress } from '../src/net/hosts'

/**
 * 添加主机。第一版**手填地址 + 令牌**;扫二维码留到有配对码通道之后再接。
 *
 * ★这一屏是照着桌面端上一轮真机点验的教训写的:
 *   - 只有一种连法(直连 ws),所以不存在「把地址填进错的框」这回事;
 *   - 校验**看内容**不只看非空;
 *   - ★错误提示挨着「保存并连接」按钮,不在页顶 —— 顶上的提示滚出视野之后,
 *     现象就是「点了没反应」,桌面端为此连卡两轮。
 */
export default function AddHost() {
  const c = useC()
  const { addHost, selectHost } = useConn()
  const [label, setLabel] = useState('')
  const [addr, setAddr] = useState('')
  const [token, setToken] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const parsed = parseAddress(addr)
  const loopback = parsed.ok && isLoopbackUrl(parsed.url)

  const save = async () => {
    const p = parseAddress(addr)
    if (!p.ok) {
      setErr(p.error)
      return
    }
    // 非回环地址,daemon 一定强制令牌。这里先说清楚,免得连上去只看到一句「鉴权失败」。
    if (!isLoopbackUrl(p.url) && !token.trim()) {
      setErr('这不是本机回环地址,daemon 会强制要令牌。在电脑上运行 daemon 时会打印它。')
      return
    }
    setErr(null)
    setSaving(true)
    try {
      const h = await addHost({
        label: label.trim() || p.url.replace(/^wss?:\/\//, ''),
        url: p.url,
        token: token.trim(),
        icon: '',
      })
      await selectHost(h.id)
      // 回对话根视图。`dismissAll()` 是给模态用的,这一层是普通推入层 —— 用它会静默什么也不做,
      // 表现就是按钮永远停在「连接中…」。
      if (router.canGoBack()) router.back()
      else router.replace('/')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => router.back()}>‹</IconBtn>}>
        <TopTitle title="添加主机" sub="电脑上运行 daemon,把它打印的地址填进来" />
      </TopBar>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
          <Sec>名称</Sec>
          <List>
            <Field value={label} onChangeText={setLabel} placeholder="书房的 Mac(不填就用地址)" autoCapitalize="none" />
          </List>

          <Sec>地址</Sec>
          <List>
            <Field
              value={addr}
              onChangeText={(v) => {
                setAddr(v)
                if (err) setErr(null)
              }}
              placeholder="192.168.110.133:6789"
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              invalid={!!err && !parsed.ok}
            />
            <T style={{ fontSize: 11.5, color: c.faint, paddingHorizontal: 2 }}>
              {addr.trim() === ''
                ? '只填 主机:端口 就行,会自动补 ws://'
                : parsed.ok
                  ? `将连接 ${parsed.url}${loopback ? ' · 回环地址,不需要令牌' : ''}`
                  : parsed.error}
            </T>
          </List>

          <Sec>访问令牌</Sec>
          <List>
            <Field
              value={token}
              onChangeText={(v) => {
                setToken(v)
                if (err) setErr(null)
              }}
              placeholder={loopback ? '回环地址可以留空' : '电脑上 daemon 启动时打印的那一串'}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={false}
            />
          </List>

          <Note>
            令牌以明文存在这台手机上,并且在同一个局域网里以明文发送。第一版只建议在自己家的 wifi
            里用;人在外面要连,等中转做完。
          </Note>

          <View style={{ height: 20 }} />
          <List>
            {/* ★提示就在按钮上面一行。别挪到页顶去。 */}
            {err ? (
              <View
                style={{
                  padding: 11,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: c.permFullBorder,
                  backgroundColor: c.bg2,
                }}
              >
                <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{err}</T>
              </View>
            ) : null}
            <Btn kind="pri" block onPress={save} disabled={saving}>
              {saving ? '连接中…' : '保存并连接'}
            </Btn>
            <Pressable onPress={() => router.back()} style={{ alignItems: 'center', paddingVertical: 12 }}>
              <T style={{ fontSize: 13.5, color: c.muted }}>取消</T>
            </Pressable>
          </List>

          <Sec>扫码配对</Sec>
          <Note>还没做。电脑端要先能生成配对码,那是第三期(中转 + 配对)的事。</Note>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
