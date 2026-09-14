// electron-builder afterSign hook（macOS）：验收签名 → 公证 .app → 装订票据 → 让 Gatekeeper 自己判。
//
// 顺序上它跑在 electron-builder 签完 .app、dmg 还没打之前。所以在这里装订，**dmg 里装进去的就是
// 一个已经带票据的 app** —— 用户把它从 dmg 拖到"应用程序"之后，即使断网也能通过 Gatekeeper。
//
// ★ `identity: null`（没配 APPLE_SIGN_IDENTITY）时 electron-builder 跳过签名步骤，这个钩子通常
//   根本不会触发；即使触发了，下面第一件事也是原样返回。现有的未签名构建行为一个字节不变。

const { join } = require('node:path')
const { existsSync } = require('node:fs')
const { signingPlan, verifyBundleSignatures, notarizeAndStaple, assertGatekeeperAccepts } = require('./macSigning.cjs')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const plan = signingPlan()
  if (plan.mode === 'adhoc') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(appPath)) {
    throw new Error(`[afterSign] 找不到 .app：${appPath}`)
  }

  // ① 先验收签名本身。这一步会在「有原生二进制没签到」时**让构建挂掉** —— 那种包公证能过、
  //    装得上、打得开，只有终端是坏的，等用户报上来就太晚了。
  verifyBundleSignatures(appPath, plan.identity)

  // ② 公证。没有公证，用户看到的还是「无法验证开发者」—— 签名等于白签。
  if (!plan.notaryProfile) {
    console.warn('[afterSign] ⚠️ FORGE_ALLOW_UNNOTARIZED=1：跳过公证。这个包**不能发给别人**，' +
      '对方打开会看到「无法验证开发者」。')
    return
  }
  notarizeAndStaple({ target: appPath, profile: plan.notaryProfile, kind: 'app' })

  // ③ 最后让 Gatekeeper 自己判一次。这是唯一能回答「用户双击到底会不会被拦」的检查 ——
  //    前面每一步都"成功"但结果仍被拦，是完全可能的。
  assertGatekeeperAccepts(appPath)
}
