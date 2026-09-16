#!/usr/bin/env bash
# 把打好的 ipa 传到 App Store Connect(TestFlight 走的就是这条路)。
#
# ★★★密钥绝不进仓库。这个脚本只从**仓库外**读凭据:
#     ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8   ← 苹果官方约定的位置,altool 自己会找
#     ~/.myflowforge/asc.env                               ← 里面两行:ASC_KEY_ID= / ASC_ISSUER_ID=
#   这两个路径都在 $HOME 下,和这个仓库没有任何关系,git 永远看不到它们。
#
# 为什么用 App Store Connect API 密钥而不是 app 专用密码:
#   ① 它是个文件,不是钥匙串条目 —— 不会像 notarytool 那个 profile 一样莫名其妙消失;
#   ② 同一把密钥 `xcrun notarytool --key/--key-id/--issuer` 也能用,mac 公证可以一起治;
#   ③ 不绑定某个人的 Apple ID 登录态,换机器拷过去就能用。
#
# 用法:
#   scripts/upload-ios.sh                      # 传默认那个 ipa
#   scripts/upload-ios.sh path/to/other.ipa
#   VALIDATE_ONLY=1 scripts/upload-ios.sh      # 只做校验不真传(第一次强烈建议先跑这个)

set -euo pipefail

IPA="${1:-mobile/ios/build/export/myFlowForge.ipa}"
ENV_FILE="$HOME/.myflowforge/asc.env"

die() { echo "✗ $*" >&2; exit 1; }

[ -f "$IPA" ] || die "找不到 ipa: $IPA"

# ── 凭据 ───────────────────────────────────────────────────────────────────────
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${ASC_KEY_ID:=}" ; : "${ASC_ISSUER_ID:=}"

if [ -z "$ASC_KEY_ID" ] || [ -z "$ASC_ISSUER_ID" ]; then
  cat >&2 <<'MSG'
✗ 没有 App Store Connect API 凭据。怎么弄(两分钟):

  1. 打开 https://appstoreconnect.apple.com → 「用户和访问」→「集成」→「App Store Connect API」
  2. 点 + 生成密钥,角色选 **App Manager**
  3. 下载那个 .p8 文件 —— ★**只能下载一次**,关掉页面就再也拿不到了
  4. 记下这一行的 **密钥 ID**(10 位)和页面顶部的 **Issuer ID**(UUID 格式)
  5. 放到位(把 ABC123DEFG 换成你的密钥 ID):

       mkdir -p ~/.appstoreconnect/private_keys ~/.myflowforge
       mv ~/Downloads/AuthKey_ABC123DEFG.p8 ~/.appstoreconnect/private_keys/
       chmod 600 ~/.appstoreconnect/private_keys/AuthKey_ABC123DEFG.p8
       cat > ~/.myflowforge/asc.env <<'EOF'
       ASC_KEY_ID=ABC123DEFG
       ASC_ISSUER_ID=你的-issuer-uuid
       EOF

  这两个位置都在 $HOME 下,不在仓库里,不会被提交。
MSG
  exit 1
fi

KEY_FILE="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
[ -f "$KEY_FILE" ] || die "凭据里写着 ASC_KEY_ID=$ASC_KEY_ID,但找不到密钥文件:$KEY_FILE"

echo "ipa:    $IPA  ($(du -h "$IPA" | cut -f1))"
echo "key id: $ASC_KEY_ID"
echo "issuer: $ASC_ISSUER_ID"

# ── 先校验 ─────────────────────────────────────────────────────────────────────
# ★校验和上传是两回事:校验能在几十秒内挑出签名、权限、图标、版本号一类的问题,
#  而上传失败往往要等把整包传完才报错。第一次一定先跑校验。
echo
echo "[1/2] 校验中(altool --validate-app)…"
xcrun altool --validate-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

if [ -n "${VALIDATE_ONLY:-}" ]; then
  echo "✓ 校验通过。VALIDATE_ONLY=1,没有上传。"
  exit 0
fi

echo
echo "[2/2] 上传中(altool --upload-app)…"
xcrun altool --upload-app -f "$IPA" -t ios \
  --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"

cat <<'DONE'

✓ 上传完成。接下来**不是立刻就能用**:
  · 苹果要先处理这个构建,5~15 分钟后才会出现在 App Store Connect 的 TestFlight 页里;
  · 处理完会让你答一次「导出合规」;
  · 然后才谈内部测试(不用审核)/ 外部测试 + 公开链接(要过一次 Beta 审核)。
DONE
