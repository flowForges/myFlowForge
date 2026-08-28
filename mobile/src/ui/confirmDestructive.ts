import { Alert, Platform } from 'react-native'

/**
 * 「web 用 window.confirm / 其余用 Alert.alert」这条路——**全 app 只写这一遍**。
 *
 * ★★为什么必须只写一遍:RN-web 的 `Alert` 是个彻头彻尾的空函数(`static alert() {}`,
 *  参数原样丢掉,0 个按钮、1 个按钮、2 个按钮**一律什么都不画**——比"只有一个按钮"还狠)。
 *  两按钮确认框在 web 上如果直接调 `Alert.alert`,连弹都不弹,人会以为按钮是坏的。
 *  这条分支已经在 `hosts.tsx` 的 `remove()` 栽过一次,后来 `archiveWs`/`confirmDeleteSession`
 *  各抄了一遍——每抄一遍就多一次「忘记这条」的机会,所以这里收成一个函数,别处只准调它。
 */
export function confirmDestructive(opts: { title: string; message: string; confirmLabel: string }): Promise<boolean> {
  const { title, message, confirmLabel } = opts
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    return Promise.resolve(typeof window !== 'undefined' && window.confirm(message))
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: '取消', style: 'cancel', onPress: () => resolve(false) },
      { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
    ])
  })
}

/**
 * 单按钮提示——「刚才那件事没做成,原因是 X」。不是确认框,没有取消/确认两条路要选。
 *
 * ★同一个理由:RN-web 的 `Alert.alert` 什么都不画,这里也必须过 `window.alert`,
 *  不能像"只是提示一下"那样想当然地直接调 `Alert.alert` 完事——那样 web 上就是又一次
 *  「点了没反应」,只是这次连按钮都没有,连误会成"按钮坏了"的机会都没给。
 */
export function notify(title: string, message: string): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof window !== 'undefined') window.alert(`${title}\n${message}`)
    return
  }
  Alert.alert(title, message)
}
