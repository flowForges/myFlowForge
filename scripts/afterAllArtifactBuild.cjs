// electron-builder afterAllArtifactBuild hook：公证并装订 **dmg 本身**。
//
// 为什么 .app 公证过了还要再来一遍：用户下载的是 dmg，quarantine 标记打在 dmg 上。dmg 自己没有
// 票据的话，挂载这一步仍可能被 Gatekeeper 挑刺。苹果的建议就是「公证你实际分发出去的那个文件」。
//
// 代价是要把 ~170MB 再传一次。试构建时可以用 FORGE_SKIP_DMG_NOTARIZE=1 跳过；
// **正式发版别跳** —— 用户下载的就是这个 dmg。

const { basename } = require('node:path')
const { signingPlan, notarizeAndStaple, signDmg } = require('./macSigning.cjs')

exports.default = async function afterAllArtifactBuild(buildResult) {
  const plan = signingPlan()
  if (plan.mode === 'adhoc' || !plan.notaryProfile) return []

  const dmgs = (buildResult.artifactPaths ?? []).filter((p) => p.endsWith('.dmg'))
  if (!dmgs.length) return []

  if (plan.skipDmgNotarize) {
    console.warn(`[notarize] ⚠️ FORGE_SKIP_DMG_NOTARIZE=1：跳过 ${dmgs.length} 个 dmg 的公证。` +
      '里面的 .app 已公证并装订，自用没问题；**要发给别人的包别这么打**。')
    return []
  }

  for (const dmg of dmgs) {
    console.log(`[notarize] dmg: ${basename(dmg)}`)
    // ★顺序是「签名 → 公证 → 装订」。漏掉签名那一步,dmg 自己过不了 Gatekeeper ——
    //  哪怕里面的 .app 完全合规(2026-09-15 实测)。
    signDmg(dmg, plan.identity)
    notarizeAndStaple({ target: dmg, profile: plan.notaryProfile, kind: 'dmg' })
  }
  // 没有新增产物，返回空数组（这个钩子的返回值是"额外要一起发布的文件"）。
  return []
}
