import { useContext, useEffect, useState } from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { CH } from '../../../src/main/ipc/channels'
import { useConn } from '../net/conn'
import { useC } from '../theme/theme'
import { RADIUS } from '../theme/tokens'
import { T } from './kit'
import { MdImageBasesCtx } from './mdImage'

/**
 * 正文里的一张**本地**图。远程 src 根本走不到这儿(解析那层就降级成链接了,见 mdImage.ts)。
 *
 * 取字节走 `file:image` → 路由到当前连的那台 host(它不在 `CLIENT_ONLY` 里),
 * 越界判断在 host 的 `resolveFileRef` 里做 —— 手机端**不自己拼路径、也不自己判越界**。
 *
 * ★失败一律退回占位符并写清原因(不在工作区内 / 文件不存在 / …)。
 *  这跟 `HtmlFallback` 是同一条规矩:画不出来就老实说画不出来,别给一个空白方块让人以为图是空的。
 */
export function MdImageBlock({ src, alt }: { src: string; alt: string }) {
  const c = useC()
  const bases = useContext(MdImageBasesCtx)
  const { invoke } = useConn()
  const [uri, setUri] = useState<string | null>(null)
  const [err, setErr] = useState('')
  // 拿到真实宽高才知道按容器宽缩成多高。没拿到之前不占位 —— 免得流式吐字时页面一跳一跳。
  const [ratio, setRatio] = useState(0)

  useEffect(() => {
    if (!bases.length) { setErr('不在工作区内'); return }
    let alive = true
    setUri(null); setErr(''); setRatio(0)
    void (async () => {
      try {
        const r = (await invoke(CH.imageFile, [{ bases, href: src }])) as { dataUrl?: string; error?: string } | null
        if (!alive) return
        if (r && r.dataUrl) setUri(r.dataUrl)
        else setErr(r?.error || '图片加载失败')
      } catch {
        if (alive) setErr('图片加载失败')
      }
    })()
    return () => { alive = false }
  }, [src, bases, invoke])

  if (err) {
    return (
      <View style={[fb.fallback, { borderColor: c.border2, backgroundColor: c.surface }]}>
        <T style={{ fontSize: 13, color: c.muted }}>🖼 {alt || src}</T>
        <T style={{ fontSize: 12, color: c.muted, marginTop: 2 }}>{err}</T>
      </View>
    )
  }
  if (!uri) return <T style={{ fontSize: 13, color: c.muted, marginBottom: 8 }}>加载图片…</T>
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={alt || undefined}
      onLoad={(e) => {
        const { width, height } = e.nativeEvent.source
        if (width > 0 && height > 0) setRatio(width / height)
      }}
      style={[st.img, { borderColor: c.border2 }, ratio ? { aspectRatio: ratio } : { height: 180 }]}
      resizeMode="contain"
    />
  )
}

// ★两次 `StyleSheet.create`:放在一个对象里的话 TS 会把 ImageStyle 和 ViewStyle 推成联合,
//  再传给 <Image> 就报 overflow 不兼容(ViewStyle 有 'scroll',ImageStyle 没有)。
const st = StyleSheet.create({
  img: { width: '100%', borderRadius: RADIUS.card, borderWidth: StyleSheet.hairlineWidth, marginBottom: 8 },
})
const fb = StyleSheet.create({
  fallback: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.card, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 8 },
})
