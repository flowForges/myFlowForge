const { withEntitlementsPlist } = require('expo/config-plugins')

/**
 * iOS 的 `aps-environment` entitlement —— **只在真的配了 Expo 推送项目时才留着**。
 *
 * ★★2026-08-30 踩到的:装上 `expo-notifications` 之后 iOS 直接**编不过**:
 *
 *   ❌ Provisioning Profile "iOS Team Provisioning Profile: com.flowforges.myflowforge"
 *      does not support the Push Notifications capability.
 *   ❌ Entitlements file defines the value "aps-environment" which is not registered for profile
 *
 *  原因:`expo-notifications` 自带一个 config plugin,而**装了就会自动生效**(不需要写进
 *  app.json 的 plugins 数组 —— 现在的 Expo 会自动应用已安装模块自带的插件)。
 *  它无条件往 entitlements 里塞 `aps-environment: development`,于是 Xcode 的自动签名
 *  要求这个 App ID 在苹果开发者后台开了 Push Notifications 能力 —— 没开就整个编译失败。
 *
 * ★★判据是 `extra.iosPush`,**不是** `extra.eas.projectId`。
 *
 *  第一版拿 projectId 当判据,那是错的 —— 它把两件独立的事绑在了一起:
 *    · 有没有 Expo 项目(`eas init` 建的)—— **安卓推送只要这个**,和苹果毫无关系;
 *    · 这个**苹果账号**能不能开推送 —— Push Notifications 是**付费会员**才有的能力。
 *  免费 Apple ID(描述文件 7 天过期的那种)**根本开不了**。于是「跑一次 eas init 想让安卓
 *  能收推送」会顺手把 iOS 构建**签名搞挂**,而报错说的是 provisioning profile,
 *  跟你刚做的那件事看起来毫不相干。2026-08-30 差点就这么咬到人。
 *
 * 所以:
 *  - 默认(没有 `extra.iosPush`)→ 删掉 `aps-environment`。包能签、能装,
 *    **本地通知照常可用**(它一条 entitlement 都不要),安卓远程推送也照常可用。
 *  - `"iosPush": true` → 留着。**这是你在声明「我这个苹果账号真的开了推送能力」** ——
 *    没开的话构建会挂,而那正是这个开关该保护你不撞上的事。
 *
 * ★iOS 远程推送要三件事(缺一不可):
 *  1. **付费**的 Apple Developer Program($99/年)—— 免费账号到这一步就走不下去了;
 *  2. 苹果后台(或 Xcode 的 Signing & Capabilities)给 App ID 勾上 Push Notifications;
 *  3. `npx eas-cli credentials` 传一次 APNs 密钥。
 *  然后在 `app.json` 的 `extra` 里加 `"iosPush": true`。
 *
 * ★安卓那条路**不需要上面任何一条**:`eas init` + 传一次 FCM 就行。
 */
module.exports = function withPushEntitlement(config) {
  // ★显式声明才放行。默认删掉 —— 默认值要站在「构建不会挂」那一边。
  if (config?.extra?.iosPush === true) return config

  return withEntitlementsPlist(config, (cfg) => {
    // ★这个 mod 必须**排在** expo-notifications 那个后面才有效(后注册的后跑)。
    //  所以它在 app.json 的 plugins 数组里放最后一个。
    delete cfg.modResults['aps-environment']
    return cfg
  })
}
