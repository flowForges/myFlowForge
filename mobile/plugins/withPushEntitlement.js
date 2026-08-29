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
 * ★★关键判断:**没有 `extra.eas.projectId` 的时候,远程推送本来就不可能工作**
 *  (`getExpoPushTokenAsync` 拿不到令牌),那条 entitlement 纯粹是个让人编不过的摆设。
 *  而**本地通知一条 entitlement 都不需要** —— 手机端那一半提醒照常可用。
 *
 * 所以这个插件按 projectId 有没有来决定:
 *  - 没有 → 删掉 `aps-environment`,包能签、能装、本地通知能用。
 *  - 有   → 原样留着,交给 Expo 那条正常路径。
 *
 * ★要真正打开远程推送,三件事缺一不可(顺序就是下面这个):
 *  1. 在**苹果开发者后台**给 App ID `com.flowforges.myflowforge` 勾上 Push Notifications;
 *  2. `npx eas init` 建 Expo 项目,把 projectId 写进 `app.json` 的 `extra.eas.projectId`;
 *  3. `npx eas credentials` 传一次 APNs 密钥(安卓传 FCM)。
 *  做完第 2 步这个插件就自动闭嘴了,不用改代码。
 */
module.exports = function withPushEntitlement(config) {
  const projectId = config?.extra?.eas?.projectId
  if (projectId) return config

  return withEntitlementsPlist(config, (cfg) => {
    // ★这个 mod 必须**排在** expo-notifications 那个后面才有效(后注册的后跑)。
    //  所以它在 app.json 的 plugins 数组里放最后一个。
    delete cfg.modResults['aps-environment']
    return cfg
  })
}
