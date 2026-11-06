# harness (mff-ai)

mff-ai 后台 agent harness,独立于桌面 app 的顶层目录(同 `relay/`、`mobile/`)。

依赖规则(`harness/boundary.test.ts` 强制):

- `harness/**` 不 import `src/**`(含 `@shared`)。
- `src/**` 只能以 `@mffai/protocol` 引用 harness。
- `harness/src/plugins/<a>` 不 import `harness/src/plugins/<b>`。
- `src/main/mffai/**` 不 import `electron`;`src/main/index.ts` 只动态 import `./mffai/host`。

## 插件

装的是别人的插件时,进工作进程的只有文字和数据,没有 JS(09 spec §5–§10)。一个插件是一个目录:Claude Code 的布局(`.claude-plugin/plugin.json`、`skills/`、`commands/`、`.mcp.json`)或原生的 `mff-plugin.json`(严格校验,权限只能收窄)。来源是本地路径或 https git 地址,按提交和内容哈希钉住,安装时插件里的任何东西都不跑。技能和命令是文字,MCP 服务是沙箱里的子进程,hooks 和别的可执行内容只列在同意页上,永远不跑。

## 开发模式

开发模式载入的 JS 跑在工作进程里,**拥有全部权限**:读得到主密钥、全部事件,绕得过权限门,这不是隔离。开启只能经 RPC `plugins.dev.trust {path, acknowledge:'runs_with_full_access'}`,模型、工具、IM 命令都碰不到。目录里要有 `mff-plugin.json`,`id` 以 `dev-` 开头,`main` 是单个打包好的 `.mjs`。确认时把 `main` 读一次,哈希和字节数随结果返回、写进 `plugins.dev.trusted`,那份字节拷到 `<数据目录>/dev-plugins/` 里,之后只载这份拷贝:改了源文件要再确认一次。下次工作进程启动才生效。载入时崩溃(30 s 内退出)的,下一次启动跳过全部开发插件,`status.problems` 报 `dev_crashed`,RPC 照常,可以 `plugins.dev.remove`。`harness/boundary.test.ts` 保证 `entry/devPlugins.ts` 是整棵树里唯一能动态载代码的地方。
