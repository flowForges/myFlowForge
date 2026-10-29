# harness (mff-ai)

mff-ai 后台 agent harness,独立于桌面 app 的顶层目录(同 `relay/`、`mobile/`)。

依赖规则(`harness/boundary.test.ts` 强制):

- `harness/**` 不 import `src/**`(含 `@shared`)。
- `src/**` 只能以 `@mffai/protocol` 引用 harness。
- `harness/src/plugins/<a>` 不 import `harness/src/plugins/<b>`。
- `src/main/mffai/**` 不 import `electron`;`src/main/index.ts` 只动态 import `./mffai/host`。
