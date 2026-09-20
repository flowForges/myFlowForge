import type { ComponentType } from 'react'
import { ROUTES } from '../src/nav/routes'
import { View } from 'react-native'
import { router } from 'expo-router'
import { goBack } from '../src/nav'
import { useC } from '../src/theme/theme'
import { Btn, IconBtn, List, Note, T, TopBar, TopTitle } from '../src/ui/kit'
import { scanSupport } from '../src/net/scanSupport'

/**
 * 「扫一扫」这条路由。**它本身不碰相机。**
 *
 * ★★真机上崩过一次:`expo-camera` 在 **import 那一行**就要原生模块,而手机上装的那个包是
 *  加相机之前打的(Expo 日常开发就是这样:改 JS 不用重装,加原生模块才要)。于是按钮照常显示、
 *  点下去 app 当场崩在 `scan.tsx:4` —— 比「没有这个功能」糟得多。
 *
 *  所以相机那一屏被挪进了 `src/scan/Scanner.tsx`,这里**先问再 require**:
 *  静态 import 会被 metro 提到最前面无条件执行,那就还是会崩。
 *  这个 require 在模块作用域只跑一次,`scanSupport()` 一辈子不会变。
 */
const support = scanSupport()
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Scanner: ComponentType | null =
  support === 'ok' ? (require('../src/scan/Scanner') as { default: ComponentType }).default : null

export default function Scan() {
  const c = useC()
  if (Scanner) return <Scanner />

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar left={<IconBtn onPress={() => goBack()}>‹</IconBtn>}>
        <TopTitle title="扫一扫" sub="这个版本用不了" />
      </TopBar>
      <Note>
        {support === 'web'
          ? '网页版没有扫码:相机开得了,但解码要浏览器的 BarcodeDetector,Safari 没有这个东西。'
          : '这个 app 是加相机之前打的包,里面没有相机模块 —— 要重装一次新包才有「扫一扫」。'}
      </Note>
      {/* ★但**电脑上那枚二维码现在就能用**:用手机自带的相机扫它,系统会按 myflowforge:// 把这个
          app 拉起来并填好 —— 那条路不需要新包,因为 scheme 早就编译进去了。
          留一条现在走得通的路,比只说一句「用不了」有用得多。 */}
      <Note>
        现在就能用的办法:退出 app,用<T style={{ fontWeight: '700', color: c.fg }}>手机自带的相机</T>
        对着电脑上那枚二维码扫一下(设置 → 主机 → 显示配对二维码),点弹出来的横幅就会回到这里并填好。
      </Note>
      <View style={{ height: 16 }} />
      <List>
        <Btn kind="pri" block onPress={() => router.replace(ROUTES.addHost)}>手填地址</Btn>
      </List>
    </View>
  )
}
