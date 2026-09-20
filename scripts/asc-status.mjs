#!/usr/bin/env node
// 查 App Store Connect:这个 app 现在有哪些构建、各自处理到哪一步了。
//
// 为什么要有这个:上传成功 ≠ 构建可用。苹果要先处理(PROCESSING),处理失败会**只发邮件**,
// TestFlight 页面上那个构建就是不出现 —— 干等是最糟的排查方式。这里直接问 API 要状态。
//
// 凭据和 upload-ios.sh 用的是同一套(~/.appstoreconnect/),仓库里没有任何密钥。
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ASC = join(homedir(), '.appstoreconnect')
const env = Object.fromEntries(
  readFileSync(join(ASC, 'asc.env'), 'utf8')
    .split('\n').filter(Boolean).map((l) => l.split('=').map((s) => s.trim())),
)
const KEY_ID = env.ASC_KEY_ID
const ISSUER = env.ASC_ISSUER_ID
const key = readFileSync(join(ASC, 'private_keys', `AuthKey_${KEY_ID}.p8`), 'utf8')

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')

function token() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
  const body = b64({ iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
  const s = createSign('SHA256')
  s.update(`${head}.${body}`)
  // ★JWS 要的是 r‖s 原始拼接(P1363),node 默认给的是 DER —— 不指定 dsaEncoding 的话
  //  签出来的 token 苹果一律返回 401,而 401 看着像"密钥不对",会把人带偏。
  const sig = s.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${head}.${body}.${sig}`
}

async function api(path) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    headers: { authorization: `Bearer ${token()}` },
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${r.status} ${path}\n${JSON.stringify(j, null, 2)}`)
  return j
}

const apps = await api('/v1/apps?limit=20')
if (!apps.data?.length) {
  console.log('这个账号下还没有任何 App 记录。')
  process.exit(0)
}
for (const app of apps.data) {
  const { name, bundleId, sku } = app.attributes
  console.log(`\n■ ${name}  (${bundleId})  sku=${sku}  id=${app.id}`)
  const builds = await api(`/v1/builds?filter[app]=${app.id}&limit=10&sort=-uploadedDate`)
  if (!builds.data?.length) { console.log('  还没有构建(刚传的话苹果还在处理,几分钟后再查)'); continue }
  for (const b of builds.data) {
    const a = b.attributes
    // ★iOS 的 build 资源里 `attributes.version` 就是 **CFBundleVersion(构建号)**,
    //  不是 1.2.0 那个版本号 —— 后者在 preReleaseVersion 关系里。名字很误导。
    console.log(
      `  · 构建号 ${String(a.version).padEnd(4)}` +
      `  状态=${a.processingState}` +
      `  过期=${a.expired ? '是' : '否'}` +
      `  上传于 ${a.uploadedDate}` +
      (a.expirationDate ? `  失效于 ${a.expirationDate}` : ''),
    )
    // 导出合规:没答的话这里是 null,构建就卡着不能分发。
    console.log(`     导出合规已答: ${a.usesNonExemptEncryption === null ? '否 ⚠️ 要去页面上答一次' : '是'}`)
  }
}
