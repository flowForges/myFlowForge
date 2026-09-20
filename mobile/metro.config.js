// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getDefaultConfig } = require('expo/metro-config')
const path = require('path')

const projectRoot = __dirname
const repoRoot = path.resolve(projectRoot, '..')

const config = getDefaultConfig(projectRoot)

// 协议层是**同一份文件**,不是抄过来的副本 —— `src/shared/remote/protocol.ts` 既被 Electron 主进程
// import,也被这里 import。开发期协议天天改,两份副本必然漂移(设计文档决策 10 就是为这个把手机端
// 放进主仓的)。Metro 默认只看得见 projectRoot 以内的文件,所以要显式把仓库根的 src/shared 加进监视。
// 监视整个 src/:除了 shared/remote/protocol.ts,还要 main/ipc/channels.ts —— 频道名也必须是同一份
// (决策 11「协议直接复用现有 channel 常量」)。channels.ts 是个没有任何 import 的纯常量对象,
// 拿进手机端 bundle 不会连坐拽进 electron。
config.watchFolders = [path.resolve(repoRoot, 'src')]

// ★只从 mobile/node_modules 解析依赖,并关掉逐级向上查找。
// 不关的话,`../src/shared/**` 里的 `import { z } from 'zod'` 会沿目录向上命中**仓库根的**
// node_modules —— 那里装着 Electron 端的 react / zod。两份 react 同时进 bundle 是 RN 里最经典的
// 白屏(hooks 报 "Invalid hook call"),而且报错完全不指向真正的原因。
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')]
config.resolver.disableHierarchicalLookup = true

module.exports = config
