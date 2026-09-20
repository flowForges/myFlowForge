/**
 * 体验模式的**剧本**。
 *
 * ★★为什么要有体验模式:这个 app 是个**客户端** —— 不连上一台跑着 myFlowForge 的电脑,
 *  打开就是一片「添加主机」的空屏。对两种人这都是致命的:
 *   ① **App Store 审核员**。他手上没有你的电脑,也不一定能访问你的中转域名(他在哪、走什么网络,
 *      你既不知道也控制不了)。把过审押在「他能连上我的服务器」上,是个不该接受的赌注。
 *   ② **第一次下载的人**。要先装桌面端、配好 daemon、扫码,才能知道这 app 值不值得装 ——
 *      这个顺序是反的。
 *  所以体验模式**必须完全离线**:不发一个字节出去,断网、飞行模式下照样能走完。
 *
 * ★这个文件**零 import**(同 `wsTile.ts` / `icons.ts`):根 vitest 里 `mobile` 那个 project
 *  跑在 node 上,带 react-native 的东西在那儿 import 不动。剧本是纯数据 + 纯函数,天然能测。
 *
 * ★★**剧本里不许出现任何真实凭据、真实路径、真实主机名**。它会被打进每一个安装包,
 *  等于公开发布。里面的工作区路径、git 分支、命令输出全是编的。
 */

/** 一次工具调用在界面上长什么样。字段名对齐 `ToolActivity`(`@shared/types`),免得转换。 */
export type DemoTool = {
  /** 卡片标题那个动词后面的东西:`Bash` / `Read` / `Edit`。 */
  name: string
  /** 副标题:命令、文件名。 */
  detail?: string
  /** 「完成」时卡片里展开能看到的输出。 */
  output?: string
  /** 这一步「跑」多久(毫秒)。剧本自己决定节奏 —— 全是 0 的话看起来就不像在干活。 */
  ms?: number
}

export type DemoReply = {
  /** 命中这条的关键词。**全部小写**,匹配时输入也会被归一化。 */
  keys: string[]
  /** 回复正文。会被逐字「流式」打出来。 */
  text: string
  /** 正文之前先跑的工具卡。 */
  tools?: DemoTool[]
  /**
   * 这一条要不要**升起一道权限门**。
   * ★权限门是这个 app 最有辨识度的东西(代理要动手之前先问你),体验模式不演它就等于没演。
   */
  gate?: { title: string; command: string }
}

/**
 * 剧本正文。★顺序无关,匹配靠关键词打分。
 * ★写的时候当成「一个真在用这个 app 的人会问什么」,不是「我想炫耀什么功能」。
 */
export const DEMO_REPLIES: readonly DemoReply[] = [
  {
    keys: ['你好', 'hi', 'hello', '在吗', '你是谁'],
    text: '在。我是跑在你电脑上的编码代理，通过 myFlowForge 接到这台手机上。\n\n现在是**体验模式**：没有连任何电脑，下面这些回答都是预先写好的。连上你自己的电脑之后，这里就是真的代理在干活。',
  },
  {
    keys: ['这是什么', '干什么用', '介绍', '能做什么', 'what'],
    text: 'myFlowForge 是一个**多 AI 编码代理的驾驶舱**。\n\n电脑上跑着 Claude Code、Codex、Gemini 这些命令行代理，它把它们收进同一个界面：一个工作区可以开多条会话、每条会话随时换模型、代理要动手之前先问你。\n\n手机端是它的**远程遥控**——代理在电脑上跑，你在外面看进度、答权限门。',
  },
  {
    keys: ['权限', '门', '安全', '会不会乱改', 'gate'],
    text: '代理要执行命令、改文件之前会**停下来问你**，就是「权限门」。\n\n你可以按工作区设权限档：全自动、只读、每次都问。门会同时出现在电脑和手机上，哪边答都行。\n\n下面这条命令就触发了一道门 ——',
    gate: { title: '执行 Bash', command: 'rm -rf node_modules && npm install' },
  },
  {
    keys: ['测试', 'test', '跑一下测试', '单测'],
    text: '测试跑完了：**318 通过，1 失败**。\n\n失败的是 `parseRelayFrame` 那条——它期望握手帧带 `v` 字段，而新版协议把版本挪进了 `meta`。这是测试没跟上实现，不是实现坏了。\n\n要我改测试还是改回协议？',
    tools: [
      { name: 'Bash', detail: 'npm test -- --run', output: '✓ src/net/relayWire.test.ts (24)\n✓ src/ui/mdParse.test.ts (41)\n✗ src/net/handshake.test.ts (1 failed)\n\n Tests  1 failed | 318 passed (319)', ms: 2600 },
      { name: 'Read', detail: 'src/net/handshake.test.ts', output: "expect(frame.v).toBe(2)\n// ↑ 协议 v3 起版本在 frame.meta.v", ms: 700 },
    ],
  },
  {
    keys: ['报错', '错误', 'error', '挂了', '崩溃', 'bug'],
    text: '找到了。`hostClient.ts:241` 在**没收到过任何 pong** 的情况下就把连接判死了。\n\n刚连上、第一个心跳还没回来的那几秒，它会误判成掉线并触发重连——于是弱网下一直在「连上→立刻断→重连」。\n\n判据得改成「**曾经收到过 pong** 才敢判死」。要我改吗？',
    tools: [
      { name: 'Grep', detail: 'setState.*retrying', output: 'src/net/hostClient.ts:241', ms: 500 },
      { name: 'Read', detail: 'src/net/hostClient.ts:230-250', output: "if (Date.now() - lastPong > PING_MS * 2) {\n  setState({ status: 'retrying', … })", ms: 600 },
    ],
  },
  {
    // ★「推送」归通知那条 —— 在这个 app 里它九成是指手机通知,不是 git push。
    keys: ['提交', 'commit', 'git', 'push'],
    text: '这轮改了 3 个文件。提交信息我写好了，你看一下：\n\n```\n:bug: relay: a socket that never ponged was being declared dead\n\nThe liveness check compared against lastPong before the first pong had\narrived, so the first few seconds of every connection looked like a\ntimeout.\n```\n\n要我提交吗？（提交会触发一道权限门。）',
    tools: [
      { name: 'Bash', detail: 'git status --short', output: ' M src/net/hostClient.ts\n M src/net/handshake.test.ts\n M src/net/relayWire.ts', ms: 400 },
      { name: 'Bash', detail: 'git diff --stat', output: ' 3 files changed, 28 insertions(+), 9 deletions(-)', ms: 400 },
    ],
  },
  {
    keys: ['工作区', 'workspace', '新建工作区', '建区'],
    text: '工作区是「一件事」的容器：一个或多个 git 仓库 + 一条工作流 + 若干会话。\n\n它会给每个仓库开独立的 git worktree，所以**几件事可以同时推进而互不打架**——你在 A 工作区让代理重构，B 工作区照样能改 bug。\n\n体验模式里只有这一个工作区；新建工作区要先连上你的电脑（它得在真的磁盘上开目录）。',
  },
  {
    keys: ['会话', 'session', '新会话', '多开'],
    text: '一个工作区能开很多条会话，各自独立上下文。常见用法是一条主线 + 一条「顺手问问」。\n\n会话之间可以随时换代理和模型——同一条会话里前半段用 Opus 想方案、后半段用便宜的模型写代码，是很常见的省钱办法。\n\n体验模式里最多开 5 条。',
  },
  {
    keys: ['工作流', 'workflow', '流水线', '阶段'],
    text: '工作流把一件事拆成有序的阶段：**需求 → 技术方案 → 开发 → 代码评审 → 汇总**。\n\n每个阶段可以指定不同的代理和模型，阶段之间有门控——技术方案那关会把文档落成文件让你过目，你点了「继续」它才往下走。\n\n不想用工作流就直接对话，两种模式随时切。',
  },
  {
    keys: ['模型', '换模型', 'opus', 'sonnet', 'gpt', '哪个模型'],
    text: '模型列表是**从各个 CLI 现问的**，不是写死在 app 里的——所以官方上新你这边马上就有，不用等我们更新。\n\n顶部那行就是切换入口，会话中途换也行。',
    tools: [{ name: 'Bash', detail: 'claude --list-models', output: 'claude-opus-5\nclaude-sonnet-5\nclaude-haiku-4-5', ms: 900 }],
  },
  {
    keys: ['中转', 'relay', '出门', '在外面', '4g', '5g', '远程'],
    text: '在家和电脑同一个 wifi 时走**局域网直连**；出门走**中转**。\n\n中转是个哑管道，两端之间端到端加密，它只看得到密文——所以用别人的中转也不影响安全。你也可以自己搭一个，十分钟的事，官网文档里有整套步骤（还有一份可以直接贴给服务器上 AI 的提示词）。',
  },
  {
    keys: ['文件', '看代码', '目录', '树', 'file'],
    text: '文件在「变更」那一屏。它读的是**你电脑上真实的工作区目录**，不是缓存。\n\n代理改过的文件会标出来，点进去能看 diff。手机上也能直接看，不用开电脑。',
    tools: [{ name: 'Read', detail: 'src/net/hostClient.ts', output: '// 342 行，已读取', ms: 600 }],
  },
  {
    keys: ['多少钱', '收费', '价格', '免费', 'price'],
    text: 'myFlowForge 本身开源免费。真正花钱的是你用的那些代理的 API/订阅额度，那笔钱直接付给它们，我们不经手。\n\n所以它不加价、也拿不到你的密钥——所有代理都是在你自己电脑上、用你自己的凭据跑的。',
  },
  {
    keys: ['开源', 'github', '源码', '仓库'],
    text: '开源的。桌面端、手机端、中转、daemon 全在同一个仓库里。\n\n中转那部分只有两百多行，专门写成能单独 clone 出去部署——你可以自己读一遍再决定要不要信它。',
  },
  {
    keys: ['隐私', '数据', '会不会上传', '安全吗'],
    text: '代理跑在**你自己的电脑上**，代码不离开你的机器。\n\n手机和电脑之间端到端加密：握手用 Ed25519 签名，内容用一次性会话密钥加密，中转全程只看得到密文。密钥不在我们手上，也不会有。',
  },
  {
    keys: ['怎么连', '配对', '扫码', '二维码', '连接'],
    text: '电脑上打开 设置 →「别人连我」，会出一枚二维码；手机上扫一下就连上了。\n\n扫完**不会自动连**——地址和令牌填好，那一下要你自己按。扫个码就把整台电脑的控制权交出去，不是个好设计。',
  },
  {
    keys: ['重构', '优化', '改代码', '帮我写'],
    text: '可以。不过在体验模式里我改不了任何真实文件——下面这几步是演示。\n\n连上你自己的电脑之后，代理就能真的读、真的改、真的跑测试，每一步动手之前都会先问你。',
    tools: [
      { name: 'Read', detail: 'src/data/store.tsx', output: '// 464 行', ms: 700 },
      { name: 'Edit', detail: 'src/data/store.tsx', output: '- const [x, setX] = useState(0)\n+ const [x, setX] = useState(() => readInitial())', ms: 900 },
    ],
  },
  {
    keys: ['安卓', 'android', 'ios', 'iphone', '手机端'],
    text: 'iPhone 和安卓都有，功能一样。\n\n桌面端支持 macOS（Intel 和 Apple 芯片）、Windows，还有一个无界面的 Linux daemon——把 daemon 跑在服务器上，手机直接连服务器也行。',
  },
  {
    keys: ['慢', '卡', '性能', '耗电'],
    text: '手机端只负责显示和操作，真正干活的是你电脑上的代理，所以手机这边很轻。\n\n断线重连是自动的，退避重试；代理那边**不会因为手机断了就停**——它在电脑上继续跑，你回来接着看就是。',
  },
  {
    keys: ['通知', '推送', '提醒'],
    text: '代理停在权限门上、或者一轮跑完了，可以推到手机。\n\n推什么你自己选：只推要你拿主意的、还是连进度一起推。半夜跑长任务的时候，「只推门」这一档很好用。',
  },
  {
    keys: ['mcp', '插件', '工具', '扩展'],
    text: '支持 MCP。装过的 MCP 服务器在这里能看到，也能在手机上给它授权。\n\n代理调 MCP 工具的时候，那次调用同样会走权限门——不会因为它是「工具」就绕过去。',
  },
  {
    keys: ['停止', '取消', '中断', 'stop'],
    text: '输入框右边那颗红色方块就是停止，跑起来之后发送键会**就地**变成它。\n\n停止会把整棵进程树收干净——代理给每条命令另开的进程组也一起杀，不留孤儿进程在后台烧 API。',
  },
  {
    keys: ['压缩', '上下文', 'context', 'token'],
    text: '上下文满了各家 CLI 会**自动压缩**，不用你管。\n\n我们不显示估算出来的百分比——各家 CLI 报的口径不一样，算出来的数不准，而一个不准的数比没有更糟：它会让你据此做决定。',
  },
  {
    keys: ['多个项目', '几个仓库', 'monorepo', '同时'],
    text: '一个工作区可以挂多个 git 仓库，代理能跨仓库改——前后端一起改的场景就是这么用的。\n\n每个仓库各自开 worktree、各自一条分支，最后一起合或者一起丢。',
  },
  {
    keys: ['diff', '变更', '改了什么', '看看改动'],
    text: '这轮的改动在「变更」那一屏，按文件列，点进去是 diff。\n\n代理说「我改好了」不算数——你自己看一眼改了什么，这是这个 app 的默认工作方式。',
    tools: [{ name: 'Bash', detail: 'git diff --stat', output: ' src/net/hostClient.ts | 19 +++++++++++--------\n 1 file changed, 11 insertions(+), 8 deletions(-)', ms: 500 },],
  },
  {
    keys: ['几点', '时间', '今天', '日期'],
    text: '体验模式里我读不到你电脑上的时间——这条回答是预先写好的。\n\n连上真机之后，问这种问题代理会真的去跑一条命令，然后把输出念给你听。',
    tools: [{ name: 'Bash', detail: 'date', output: '(体验模式：不会真的执行)', ms: 400 }],
  },
  {
    keys: ['退出体验', '怎么退出', '结束体验', '连我自己的'],
    text: '右上角退出体验模式，然后按「添加主机」扫你电脑上那枚二维码就行。\n\n电脑上先装好 myFlowForge，打开 设置 →「别人连我」，码就在那儿。',
  },
  {
    keys: ['谢谢', '不错', '好的', '厉害', '赞'],
    text: '够用就好。真正值得试的是连上你自己的电脑之后——体验模式只能演，代理真干起活来才有意思。',
  },
]

/** 什么都没匹配上的时候说什么。★必须明说这是体验模式,别装成真的答上来了。 */
export const DEMO_FALLBACK =
  '这句我没有预先写好的回答——**体验模式是完全离线的**，不会把你的话发到任何地方，所以我只能照剧本答。\n\n连上你自己的电脑之后，这里就是真的编码代理：它会读你的代码、跑你的命令、改你的文件，每一步动手前先问你。\n\n想看点别的，试试问「权限门是什么」「帮我跑一下测试」「怎么连我自己的电脑」。'

/** 归一化:去掉空白和常见标点,转小写。中英文一视同仁。 */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s,.!?;:，。！？；：、"'"'（）()【】\[\]]/g, '')
}

/**
 * 挑一条回复。
 *
 * ★打分而不是「第一个包含就算」:短关键词(`git`)会在长句子里到处命中,
 *  按**命中的关键词长度**取最高分,长的更具体,也就更可能是人真正在问的那件事。
 * ★一条都没中就回落 —— **绝不瞎编**。
 */
export function pickReply(input: string): DemoReply | null {
  const q = normalize(input)
  if (!q) return null
  let best: DemoReply | null = null
  let bestScore = 0
  for (const r of DEMO_REPLIES) {
    for (const k of r.keys) {
      const key = normalize(k)
      if (key && q.includes(key) && key.length > bestScore) {
        bestScore = key.length
        best = r
      }
    }
  }
  return best
}

/** 回复正文 + 工具卡。没匹配上就用兜底那段(兜底不带工具卡 —— 演一个查不到东西的调用没有意义)。 */
export function replyFor(input: string): DemoReply {
  return pickReply(input) ?? { keys: [], text: DEMO_FALLBACK }
}
