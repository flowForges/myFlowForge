import { useRef, useState } from 'react'
import { ROUTES } from '../nav/routes'
import { Pressable, View } from 'react-native'
import { router } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { goBack } from '../nav'
import { useC } from '../theme/theme'
import { Btn, IconBtn, List, Note, T, TopBar, TopTitle } from '../ui/kit'
import { parsePairingLink } from '@shared/remote/pairingLink'

/**
 * 扫电脑上那枚配对二维码。
 *
 * ★这一屏其实是**可有可无**的:同一枚码用手机自带的相机扫,系统会直接按 `myflowforge://`
 *  深链把 app 拉起来并落到「添加主机」——**一步都不用多**。做这一屏只是因为「app 里怎么没有扫一扫」
 *  是个人人都会问的问题,而回答「去用系统相机」听起来像在推脱。
 *  两条路解出来的东西完全一样(同一个 `parsePairingLink`),所以不存在「哪条更灵」。
 *
 * ★★**这个文件绝不能被静态 import。** `expo-camera` 在 import 那一行就要原生模块,
 *  装在手机上的包里没有的话当场抛。所以路由 `app/scan.tsx` 是先问 `scanSupport()`、
 *  确定有才 `require` 进来 —— 详见那个文件。
 */
export default function Scanner() {
  const c = useC()
  const [perm, requestPerm] = useCameraPermissions()
  const [err, setErr] = useState<string | null>(null)
  // ★相机会**连着**回调,一秒好几次。不上锁的话一枚码会往「添加主机」推好几层,
  //  用户按返回要按五次才退得出去 —— 而且每一层都在自己发起连接。
  const done = useRef(false)

  const onScan = ({ data }: { data: string }) => {
    if (done.current) return
    const r = parsePairingLink(data)
    if (!r.ok) {
      // 别锁死:扫到别的码(付款码、wifi 码)时,把摄像头继续开着让人对准正确的那枚,
      // 只是把原因说出来。
      setErr(r.error)
      return
    }
    done.current = true
    // ★`replace` 不是 `push`:扫码屏不该留在返回栈里。留着的话,从「添加主机」按返回
    //  会退回一个还开着的摄像头,它立刻又扫到同一枚码,把人弹回去 —— 一个退不出去的环。
    router.replace({
      pathname: '/add-host',
      // ★`k`/`r` 缺省时传空串而不是不传:`useLocalSearchParams` 对"没有这个键"和
      //  "值是空串"给出的都是 undefined/'',下游 `one()` 已经统一处理,传空串更省一层判断。
      params: {
        a: r.value.address,
        t: r.value.token,
        n: r.value.label,
        k: r.value.pubKey ?? '',
        r: r.value.relay ?? '',
      },
    })
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="扫一扫" sub="对准电脑上「设置 → 主机」里那枚码" />
      </TopBar>

      {!perm ? (
        // 权限状态还没读出来。空着就行,这一瞬很短。
        <View style={{ flex: 1 }} />
      ) : !perm.granted ? (
        <View style={{ padding: 16, gap: 14 }}>
          <Note>
            要用一次相机来读那枚二维码。不拍照、不上传,扫到就关。
            {perm.canAskAgain ? '' : '你之前拒绝过,得去系统「设置 → myFlowForge → 相机」里打开。'}
          </Note>
          {perm.canAskAgain ? (
            <List>
              <Btn kind="pri" block onPress={() => void requestPerm()}>允许使用相机</Btn>
            </List>
          ) : null}
          <List>
            {/* ★永远留一条不用相机的路。权限被拒之后只剩一个死胡同,是最让人恼火的设计。 */}
            <Btn block onPress={() => router.replace(ROUTES.addHost)}>改成手填地址</Btn>
          </List>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScan}
          />
          <View style={{ padding: 16, gap: 12 }}>
            {err ? (
              <View style={{ padding: 11, borderRadius: 12, borderWidth: 1, borderColor: c.permFullBorder, backgroundColor: c.bg2 }}>
                <T style={{ fontSize: 13, lineHeight: 20, color: c.err }}>{err}</T>
              </View>
            ) : (
              <Note>在电脑上打开「设置 → 主机 → 显示配对二维码」。</Note>
            )}
            <Pressable onPress={() => router.replace(ROUTES.addHost)} style={{ alignItems: 'center', paddingVertical: 8 }}>
              <T style={{ fontSize: 13.5, color: c.muted }}>改成手填地址</T>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  )
}
