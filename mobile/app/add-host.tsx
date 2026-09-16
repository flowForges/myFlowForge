import { useState } from 'react'
import { ROUTES } from '../src/nav/routes'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import { goBack, goToHosts } from '../src/nav'
import { one } from '../src/routeParams'
import { useC } from '../src/theme/theme'
import { Btn, Field, IconBtn, List, Note, Sec, T, TopBar, TopTitle } from '../src/ui/kit'
import { useConn } from '../src/net/conn'
import { hostLabel, isLoopbackUrl, parseAddress } from '../src/net/hosts'
import { scanSupport } from '../src/net/scanSupport'

/** ★这个包里到底有没有相机。模块作用域算一次就够,它一辈子不会变。 */
const CAN_SCAN = scanSupport() === 'ok'

/**
 * 添加主机。手填地址 + 令牌,或者**从二维码填进来**。
 *
 * ★两条扫码路径落到的是**同一个地方**:
 *   ① 用手机自带的相机扫 → 系统按 `myflowforge://add-host?a=…&t=…&n=…` 深链把 app 拉起来,
 *     直接落到这一屏(app 没开着也行);
 *   ② app 里点「扫一扫」→ `scan.tsx` 解完之后 `router.replace` 到这一屏,带同样的参数。
 *  参数名 `a/t/n` 和链接格式由 `@shared/remote/pairingLink` 一处定义,桌面端 import 的是同一份文件。
 *
 * ★扫完**不自动连**。地址和令牌是填好的,但那一下要人自己按 —— 一枚码扫进来就把整台电脑的
 *  控制权接上,和「扫个码就付款」是一回事。而且填好之后人能先核对一眼扫到的是不是自己那台。
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
  // ★用 useState 的**初值**读参数,不要写进 effect 里回填 —— effect 每次参数对象换新引用都会跑一遍,
  //  会把人已经改过的地址悄悄推回二维码里那个值。
  const q = useLocalSearchParams<{ a?: string; t?: string; n?: string; k?: string; r?: string }>()
  const [scanned] = useState(() => !!one(q.a))
  const [label, setLabel] = useState(() => one(q.n))
  const [addr, setAddr] = useState(() => one(q.a))
  const [token, setToken] = useState(() => one(q.t))
  /**
   * 身份公钥和中转地址。★**只读,不给人改** —— 它们不是"设置",是配对码搬过来的事实。
   *  手输一把公钥没有任何意义(错一个字符就连不上,而且没人核对得了),
   *  所以这两样没有输入框,只在下面显示一行"这台会加密 / 走中转"。
   */
  const [pubKey] = useState(() => one(q.k))
  const [relay] = useState(() => one(q.r))
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
    // ★走中转时也必须有令牌:那条路上 daemon 一样开着 token 校验(两条路共用同一个)。
    //  只按地址判的话,一个填了回环地址 + 中转的记录会被放过,然后在握手后被 4403 断掉。
    if ((!isLoopbackUrl(p.url) || relay.trim()) && !token.trim()) {
      setErr('这不是本机回环地址,daemon 会强制要令牌。在电脑上运行 daemon 时会打印它。')
      return
    }
    setErr(null)
    setSaving(true)
    try {
      const h = await addHost({
        // ★空名回落成地址这条规矩收在 `hostLabel` 一处 —— 重命名和读盘兜底用的是同一份。
        label: hostLabel(label, p.url),
        url: p.url,
        token: token.trim(),
        icon: '',
        // 空串一律存 undefined —— 下游只判「有没有」,不用再各写一遍 `x && x !== ''`。
        pubKey: pubKey.trim() || undefined,
        relay: relay.trim() || undefined,
      })
      await selectHost(h.id)
      // ★回**主机列表**,不是 goBack()。见 nav.ts 的 goToHosts:扫码那条路会在栈里留下两个
      //  add-host,goBack() 会落回下面那个空的(真机验收报的「加完停在空白页」)。
      //  落在主机列表上还有一个好处:刚加的那台就在列表里,连接状态当场看得见。
      goToHosts()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="添加主机" sub={scanned ? '已从二维码填好,核对一下就能连' : '扫电脑上那枚码,或者手填地址'} />
      </TopBar>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}>
          {scanned ? (
            <Note>
              {/* ★`Note` 是纯文本,不认 markdown —— 写 **粗体** 会原样显示两个星号。加粗要套一层 T。 */}
              下面这些是从二维码里读出来的。确认一眼这是
              <T style={{ fontWeight: '700', color: c.fg }}>你自己那台电脑</T>
              {' '}—— 连上去等于把起 agent、答权限门、开终端的权力交出去。
            </Note>
          ) : !CAN_SCAN ? (
            // ★扫不了就**不摆这个按钮**。
            //  真机上崩过一次:手机上装的包是加相机之前打的,按钮照常显示、点下去 app 当场崩。
            //  网页版是另一个原因(Safari 没有 BarcodeDetector),但对人来说是同一件事:这条路走不通。
            //  ★仍然给一条**现在就走得通**的路 —— 手机自带的相机扫那枚码不需要新包。
            <Note>
              这个版本没有 app 内扫码。不过用<T style={{ fontWeight: '700', color: c.fg }}>手机自带的相机</T>
              扫电脑上那枚二维码(设置 → 主机 → 显示配对二维码)照样会跳回这一屏并填好,或者在下面手填。
            </Note>
          ) : (
            <List>
              {/* ★快的那条路放最上面。二维码在电脑的「设置 → 主机 → 显示配对二维码」里。 */}
              <Btn kind="pri" block onPress={() => router.push(ROUTES.scan)}>扫一扫</Btn>
              <T style={{ fontSize: 11.5, color: c.faint, textAlign: 'center', paddingTop: 2 }}>
                电脑上:设置 → 主机 → 显示配对二维码
              </T>
            </List>
          )}

          {/* ★★两条路之间必须有一道看得见的界。没有它的时候,「扫一扫」和下面的输入框读起来像
              **一件事的两步**(扫完还要自己填),而它们其实是**二选一**。
              真机反馈的原话是「顶部有个扫一扫,底部有个保存并连接,中间什么也没填,这两个按钮很奇怪」
              —— 奇怪的根源正是这里缺一句话。扫码进来时(scanned)不摆:那条路上没有选择。 */}
          {!scanned ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingTop: 16 }}>
              <View style={{ flex: 1, height: 1, backgroundColor: c.border2 }} />
              <T style={{ fontSize: 11.5, color: c.faint }}>或者手动填写</T>
              <View style={{ flex: 1, height: 1, backgroundColor: c.border2 }} />
            </View>
          ) : null}

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
            令牌以明文存在这台手机上。同一个 wifi 下走的是局域网直连(明文),人在外面走中转时
            则是端到端加密的。要在外面连,先在电脑上配好中转地址(设置 → 手机),再扫一次码。
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
            {/* ★★这颗按钮**只在这一屏有"第二主角"的问题**:没扫码时,顶上那颗「扫一扫」才是推荐路径,
                两颗都画成 `pri` 就是两个同样响亮的主行动在抢,而底下这颗在表单空着时**只能失败**
                —— 一个点下去必然弹错的按钮,不该长得像整页的主按钮(真机反馈:「这两个按钮很奇怪」)。
                所以:手填这条路上它是次级样式,扫码进来时(没有「扫一扫」和它抢)才是 `pri`。
                ★★禁用**必须配一句为什么**。光禁用而不说,就变成另一种「点了没反应」——
                这一屏顶部注释里记的桌面端那两轮,栽的就是这个。 */}
            <Btn kind={scanned ? 'pri' : 'default'} block onPress={save} disabled={saving || !addr.trim()}>
              {saving ? '连接中…' : '保存并连接'}
            </Btn>
            {!addr.trim() && !saving ? (
              <T style={{ fontSize: 11.5, color: c.faint, textAlign: 'center', paddingTop: 2 }}>
                {CAN_SCAN ? '先填上面的地址,或者用「扫一扫」一次填好' : '先填上面的地址'}
              </T>
            ) : null}
            <Pressable onPress={() => goBack()} style={{ alignItems: 'center', paddingVertical: 12 }}>
              <T style={{ fontSize: 13.5, color: c.muted }}>取消</T>
            </Pressable>
          </List>

        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}
