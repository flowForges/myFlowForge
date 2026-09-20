import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUTO_POLICY, type GateOrigin } from './gateRegistry'
import { NOTIFY_ORIGINS } from '../notify/notifyBridge'
import { PUSH_ORIGINS } from '../../shared/push/fromEvent'

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * ★注释必须先剥掉,否则守卫会被**它自己的说明文字**喂饱:本文件里写着「原来是
 *  `deps.onConfirm ?? Promise.resolve('allow')`」,而那正是要禁的图案。
 *  同一个跟头 `hostsClassNames.test.ts` 已经栽过一次 —— 那边的注释里写着「不要自造 .set-label」,
 *  守卫第一次跑就是被这行注释骗成绿的。
 */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')

/**
 * ★★★这个文件是「第 5 次漏门」的**刹车**。
 *
 * 前四次都是哪漏补哪,第五次普查才看清:漏不是手误,是结构 —— 新增一条执行路径要同时想起
 * 五件事(起 resolver、定事件、加渲染组件、去 notifyBridge 加 case、去 push/fromEvent 加 case),
 * 而**最后两步没有任何东西会提醒你**,偏偏它们决定了「用户在别处能不能知道有门在等」。
 *
 * 所以这里不测某条路径好不好用,只钉死三件**能机械验证**的事:
 *   ① 每一个 GateOrigin 都必须被分类,而且**恰好一次**;
 *   ② 桌面通知和手机推送认的是**同一批**来源(桌面响了手机不响,等于人离开电脑就瞎了);
 *   ③ 会起 provider 的文件,要么从总线拿门,要么在这儿写明它为什么不用。
 */

/** 还在用自己那条旧事件通知的(chat:event / run2:event)。★迁移完成后这张表会空掉。 */
const LEGACY_NOTIFIED: GateOrigin[] = ['chat', 'run2']

describe('门的覆盖率', () => {
  it('★★每个来源恰好被分类一次:总线通知 / 旧事件通知 / 自动决定', () => {
    const ALL: GateOrigin[] = ['chat', 'run2', 'setup', 'delegate', 'oneshot']
    for (const o of ALL) {
      const hits = [
        NOTIFY_ORIGINS.has(o) ? '总线通知' : null,
        LEGACY_NOTIFIED.includes(o) ? '旧事件通知' : null,
        o in AUTO_POLICY ? '自动决定' : null,
      ].filter(Boolean)
      expect(hits, `来源「${o}」被分了 ${hits.length} 次(${hits.join('+')})—— 必须恰好一次。\n` +
        '漏分 = 门升起来了但没人会被告知;重复 = 同一道门响两次。').toHaveLength(1)
    }
  })

  it('★★桌面通知和手机推送必须认同一批来源', () => {
    // 只在桌面响,人一离开电脑就什么都不知道 —— 而「离开电脑」正是远程/手机端存在的理由。
    expect([...PUSH_ORIGINS].sort(), '两张表不一样了').toEqual([...NOTIFY_ORIGINS].sort())
  })

  /**
   * 会起 provider 的地方,门必须有着落。
   * ★允许两种着落:从总线拿(import gateRegistry),或者在下面这张表里写明「我是透传层,
   *  回调由调用方给」—— 而透传层**不许自己写 onConfirm 的字面量**,否则它就成了第六份抄本。
   */
  const PASS_THROUGH: Record<string, string> = {
    'run/executeHook.ts': '透传层:回调整个由调用方给,自己只包 onLog/onState',
    'run/workOrder.ts': '透传层:onConfirm 是必填入参,由 controller/engine 注入',
    'run/fanout.ts': '透传层:把 deps 原样交给 workOrder',
    // ★run2(工作流)还在用自己那套 laneR + `run2:event kind:'auth'`,属 LEGACY_NOTIFIED。
    //  它**有**门、也**有**通知,只是还没搬到总线上 —— 迁移的下一站就是它。
    'run/controller.ts': 'run2 自有 resolver + run2:event,属 LEGACY_NOTIFIED(待迁)',
  }

  /**
   * 允许写死一个决定的地方 —— 而且**只允许写 deny**。
   * ★放行必须是某个人或某条策略当场决定的;写死一个 allow 等于给「没人看着」的那条路配了一把万能钥匙。
   */
  const EXPLICIT_DENY: Record<string, string> = {
    'run/engine.ts': '无人值守 headless:没有任何界面在场,一律拒',
  }

  it('★起 provider 的文件,要么从总线拿门,要么写明为什么不用', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue
        const src = stripComments(readFileSync(p, 'utf8'))
        // provider.run( / provider.chat( / deps.provider.run( …
        if (!/\bprovider[?!]?\.(run|chat)[?!]?\(/.test(src)) continue
        const rel = relative(MAIN, p)
        if (rel in PASS_THROUGH || rel in EXPLICIT_DENY) continue
        if (src.includes("gate/gateRegistry")) continue
        offenders.push(rel)
      }
    }
    walk(MAIN)
    expect(offenders, '这些文件会起 provider,但门既不走总线,也没在 PASS_THROUGH 里说明:\n' +
      offenders.join('\n') + '\n新增一条执行路径时,这条断言就是来拦你的。').toEqual([])
  })

  it('★写死决定的地方只许写 deny —— 万能钥匙不许存在', () => {
    for (const rel of Object.keys(EXPLICIT_DENY)) {
      const src = stripComments(readFileSync(join(MAIN, rel), 'utf8'))
      expect(src, `${rel} 写死了 allow`).not.toMatch(/onConfirm:\s*(async)?\s*\(\s*\)\s*=>\s*['"]allow['"]/)
      expect(src, `${rel} 说好是显式 deny,却没写`).toMatch(/onConfirm:\s*(async)?\s*\(\s*\)\s*=>\s*['"]deny['"]/)
    }
  })

  it('★透传层不许自己写 onConfirm 的字面量 —— 那就是第六份抄本', () => {
    for (const rel of Object.keys(PASS_THROUGH)) {
      const src = stripComments(readFileSync(join(MAIN, rel), 'utf8'))
      // 允许 `onConfirm: (req) => deps.onConfirm(...)` 这种转发;不允许直接写死一个决定。
      expect(src, `${rel} 里写死了一个决定`).not.toMatch(/onConfirm:\s*(async)?\s*\(\s*\)\s*=>\s*['"](allow|deny)['"]/)
    }
  })

  it('★★src/main 里不许再出现「静默全放行」', () => {
    // 放行可以,但必须是某个地方**明确决定**的(权限档自动放行、AUTO_POLICY),
    // 而不是一句藏在调用点的 `?? 'allow'` —— 工作流泳道就这么全放行了很久。
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!p.endsWith('.ts') || p.endsWith('.test.ts')) continue
        const src = stripComments(readFileSync(p, 'utf8'))
        if (/onConfirm\s*(\?\?|\|\|)\s*[^\n]*['"]allow['"]/.test(src) ||
            /onConfirm:\s*(async)?\s*\(\s*\)\s*=>\s*['"]allow['"]/.test(src)) {
          offenders.push(relative(MAIN, p))
        }
      }
    }
    walk(MAIN)
    expect(offenders, '这些地方在没人看的情况下默认放行:\n' + offenders.join('\n')).toEqual([])
  })
})
