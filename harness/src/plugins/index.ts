import type { Plugin } from '../kernel/pluginHost'
import channelTelegram from './channel-telegram'
import executorCli from './executor-cli'
import loopDefault from './loop-default'
import loopDirect from './loop-direct'
import loopEcho from './loop-echo'
import memoryDefault from './memory-default'
import modelAnthropic from './model-anthropic'
import modelChatgpt from './model-chatgpt'
import modelOpenai from './model-openai'
import modelsRegistry from './models-registry'
import { createPluginManager } from './plugin-manager'
import toolsCoding from './tools-coding'
import toolsRegistry from './tools-registry'

// 本期静态登记的内置插件;顺序:models-registry → 协议适配器 → tools-registry → tools-coding → executor-cli → memory-default → plugin-manager → loop-default → loop-direct → loop-echo → channel-telegram
// 保留 id 懒求值:列表里有 plugin-manager 自己,模块求值时还没有这个数组
const pluginManager = createPluginManager({ reservedIds: () => new Set(BUILTIN_PLUGINS.map(p => p.manifest.id)) })

export const BUILTIN_PLUGINS: Plugin[] = [modelsRegistry, modelOpenai, modelAnthropic, modelChatgpt, toolsRegistry, toolsCoding, executorCli, memoryDefault, pluginManager, loopDefault, loopDirect, loopEcho, channelTelegram]
