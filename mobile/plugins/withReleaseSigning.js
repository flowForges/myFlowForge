const { withAppBuildGradle } = require('expo/config-plugins')

/**
 * 让 release 包用**你自己的正式密钥**签名,而不是 Expo 模板默认的调试密钥。
 *
 * ★★为什么必须是 config plugin 而不是直接改 `android/app/build.gradle`:
 *  `expo prebuild` 会**重新生成整个 `android/`**,手改的东西下次就没了。2026-09-15 实测:
 *  `npm run --prefix mobile native:check` 里就有 prebuild,它当场把我写的 `local.properties`
 *  冲掉了 —— 直接改生成物,等于把改动交给下一次 prebuild 决定还在不在。
 *
 * ★★★为什么这件事必须在**发第一个测试包之前**做:
 *  安卓用**签名密钥**认 app 的身份。先用调试密钥发 beta、之后换正式密钥,所有装过 beta 的人
 *  **必须卸载才能升级**(签名不一致直接被系统拒),数据全丢。而且调试密钥是公开的
 *  (口令就是 `android`,全世界一样),任何人都能签一个"同一个 app"覆盖安装。
 *
 * ── 密钥和口令都在仓库外 ───────────────────────────────────────────────────────────
 * 密钥文件:`~/keys/myflowforge-release.keystore`(自己 keytool 生成,和苹果不同 ——
 *          安卓的密钥是你自己造的,不用申请、不花钱、也没人能帮你补办)
 * 四个口令:`~/.gradle/gradle.properties`(用户全局,不在仓库里)
 *
 *   MYFLOWFORGE_STORE_FILE=/Users/你/keys/myflowforge-release.keystore
 *   MYFLOWFORGE_STORE_PASSWORD=…
 *   MYFLOWFORGE_KEY_ALIAS=myflowforge
 *   MYFLOWFORGE_KEY_PASSWORD=…
 *
 * ★四个缺任何一个就**自动回落到调试签名**并打一行醒目日志。理由:别人克隆这个仓库、或者你换台
 *  机器,构建应该照样能跑 —— 因为"没有密钥"而让 `assembleDebug` 也挂掉是荒谬的。
 *  但回落**必须说出来**,否则就变成「以为发的是正式签名、其实是调试签名」,那才是最坏的结果。
 *
 * ★验收只认 `apksigner verify --print-certs` 打出来的证书 DN。**文件名说明不了任何事** ——
 *  调试签名的产物也叫 `app-release.apk`。
 */

const MARKER = '// myFlowForge release signing (withReleaseSigning.js)'

const SIGNING_CONFIG = `
${MARKER}
def forgeStoreFile = project.findProperty('MYFLOWFORGE_STORE_FILE')
def forgeStorePassword = project.findProperty('MYFLOWFORGE_STORE_PASSWORD')
def forgeKeyAlias = project.findProperty('MYFLOWFORGE_KEY_ALIAS')
def forgeKeyPassword = project.findProperty('MYFLOWFORGE_KEY_PASSWORD')
def forgeHasReleaseKey = forgeStoreFile && forgeStorePassword && forgeKeyAlias && forgeKeyPassword && file(forgeStoreFile).exists()
`

/** 在 android { … } 里追加 forgeRelease 签名配置。 */
function injectSigningConfig(contents) {
  return contents.replace(
    /signingConfigs\s*\{/,
    `signingConfigs {
        forgeRelease {
            if (forgeHasReleaseKey) {
                storeFile file(forgeStoreFile)
                storePassword forgeStorePassword
                keyAlias forgeKeyAlias
                keyPassword forgeKeyPassword
            }
        }`,
  )
}

/** 把 release 的 signingConfig 从 debug 换成 forgeRelease(没密钥时仍用 debug)。 */
function switchReleaseSigning(contents) {
  return contents.replace(
    /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
    `$1signingConfig forgeHasReleaseKey ? signingConfigs.forgeRelease : signingConfigs.debug
            // ★回落必须说出来 —— 静默用调试密钥发版,是「以为签对了其实没有」那类事故的源头。
            if (!forgeHasReleaseKey) {
                logger.lifecycle("⚠️  [myFlowForge] 没找到正式签名密钥,release 包将用**调试密钥**签名。")
                logger.lifecycle("    这种包能装能用,但和正式密钥签的 app 互不兼容(升级要卸载重装)。")
                logger.lifecycle("    配置方法见 mobile/plugins/withReleaseSigning.js 顶部。")
            } else {
                logger.lifecycle("✓ [myFlowForge] release 包使用正式签名密钥: " + forgeKeyAlias)
            }`,
  )
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('[withReleaseSigning] 只支持 groovy 的 build.gradle')
    }
    if (cfg.modResults.contents.includes(MARKER)) return cfg   // 幂等:prebuild 可能跑多次
    let out = cfg.modResults.contents
    // 常量声明要放在 android { } 之前 —— Groovy 里 def 必须先于使用。
    out = out.replace(/^android\s*\{/m, `${SIGNING_CONFIG}\nandroid {`)
    out = injectSigningConfig(out)
    out = switchReleaseSigning(out)
    cfg.modResults.contents = out
    return cfg
  })
}
