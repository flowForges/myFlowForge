import { describe, expect, it } from 'vitest'
import {
  buildCreatePayload,
  checkWsName,
  classifyCreateError,
  filterProjects,
  joinPath,
  missingMethods,
  orderBrowseDirs,
  setupProgressText,
  stageDisplayName,
  stageLabels,
  whyNotCreate,
  type FormState,
} from './newWorkspace'

// ★这一屏的名字校验是**从网络到文件系统**的最后一道闸:它拼出来的路径,主机会真的去 mkdir。
//  所以每一条拒绝单独一个用例,而且每个用例的输入**只踩一条规则** —— 这样删掉任何一条守卫
//  都会有且只有对应的那个用例变红(别的用例不会替它兜住,那正是假绿的来源)。
describe('checkWsName', () => {
  it('accepts an ordinary name and returns it trimmed', () => {
    expect(checkWsName('  我的工作区  ')).toEqual({ ok: true, name: '我的工作区' })
  })

  it('rejects empty', () => {
    expect(checkWsName('')).toEqual({ ok: false, reason: '给这个工作区起个名字' })
  })

  it('rejects whitespace-only (it trims to empty)', () => {
    expect(checkWsName('   \t  ').ok).toBe(false)
  })

  it('rejects a forward slash — that would escape the chosen parent directory', () => {
    expect(checkWsName('a/b').ok).toBe(false)
  })

  it('rejects a backslash too, because the host may be Windows', () => {
    expect(checkWsName('a\\b').ok).toBe(false)
  })

  it('rejects `..` even in the middle, where the leading-dot rule would not catch it', () => {
    // 刻意不用 `..`:那个会被「以 . 开头」那条一并挡住,于是删掉本条守卫用例照样绿。
    expect(checkWsName('a..b').ok).toBe(false)
  })

  it('rejects a leading dot, where the `..` rule would not catch it', () => {
    // 同理:`.hidden` 里没有两个连着的点。
    expect(checkWsName('.hidden').ok).toBe(false)
  })

  it('rejects an embedded NUL / control character', () => {
    expect(checkWsName('ab\u0000cd').ok).toBe(false)
  })

  it('accepts exactly 64 code points and rejects 65', () => {
    // ★上下界都写**字面量**,不写 WS_NAME_MAX:拿常量当基准的话,把上限改成 3 之后
    //  两条断言会跟着常量一起挪,测试全绿 —— 这正是今天两个子代理踩到的那种假绿。
    expect(checkWsName('a'.repeat(64)).ok).toBe(true)
    expect(checkWsName('a'.repeat(65)).ok).toBe(false)
  })

  it('counts code points, not UTF-16 units: 64 emoji is fine even though .length is 128', () => {
    const emoji = '🙂'.repeat(64)
    expect(emoji.length).toBe(128)
    expect(checkWsName(emoji).ok).toBe(true)
  })

  it('measures the TRIMMED name, so surrounding spaces do not eat the budget', () => {
    expect(checkWsName('  ' + 'a'.repeat(64) + '  ').ok).toBe(true)
  })
})

describe('joinPath', () => {
  it('joins a posix parent', () => {
    expect(joinPath('/Users/me/code', '新区')).toBe('/Users/me/code/新区')
  })

  it('does not double the separator when the parent already ends with one', () => {
    expect(joinPath('/Users/me/code/', '新区')).toBe('/Users/me/code/新区')
  })

  it('handles the posix root without producing //name', () => {
    expect(joinPath('/', 'w')).toBe('/w')
  })

  it('uses a backslash when the parent is a Windows path', () => {
    expect(joinPath('C:\\Users\\me', 'w')).toBe('C:\\Users\\me\\w')
  })

  it('handles a Windows drive root', () => {
    expect(joinPath('C:\\', 'w')).toBe('C:\\w')
  })

  it('treats a mixed-separator parent as posix (Windows accepts forward slashes)', () => {
    expect(joinPath('C:/Users/me', 'w')).toBe('C:/Users/me/w')
  })
})

describe('orderBrowseDirs', () => {
  it('drops files: you cannot put a workspace inside a file', () => {
    const out = orderBrowseDirs([
      { name: 'readme.md', dir: false },
      { name: 'src', dir: true },
    ])
    expect(out.map((e) => e.name)).toEqual(['src'])
  })

  it('sorts by name', () => {
    const out = orderBrowseDirs([
      { name: 'zeta', dir: true },
      { name: 'alpha', dir: true },
      { name: 'mid', dir: true },
    ])
    expect(out.map((e) => e.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('does not mutate the input array', () => {
    const input = [
      { name: 'b', dir: true },
      { name: 'a', dir: true },
    ]
    orderBrowseDirs(input)
    expect(input.map((e) => e.name)).toEqual(['b', 'a'])
  })
})

describe('missingMethods', () => {
  it('is empty when the host advertises all six', () => {
    // ★六条名字写字面量,不从 CH 取:CH 里改错一个 key,拿 CH 当基准的断言会跟着一起改。
    const has = new Set([
      'fs:browse',
      'fs:browse-roots',
      'config:list-projects',
      'config:list-workflows',
      'custom-stages:list',
      'workspace:create',
    ])
    expect(missingMethods(has)).toEqual([])
  })

  it('names exactly what is missing', () => {
    const has = new Set([
      'fs:browse',
      'fs:browse-roots',
      'config:list-projects',
      'custom-stages:list',
      'workspace:create',
    ])
    expect(missingMethods(has)).toEqual(['config:list-workflows'])
  })

  it('reports every one of them when the host advertises nothing', () => {
    expect(missingMethods(new Set())).toHaveLength(6)
  })
})

describe('classifyCreateError', () => {
  it('reads the wire message, because the Error NAME does not survive the gateway', () => {
    // 主进程抛 `new Error('SETUP_CANCELLED')`(name = SetupCancelledError);
    // protocol.ts 的 errorText() 只带 message 过来。字面量写死。
    expect(classifyCreateError('SETUP_CANCELLED')).toBe('cancelled')
  })

  it('does not mistake the desktop-side error NAME for a cancel', () => {
    expect(classifyCreateError('SetupCancelledError')).toBe('failed')
  })

  it('treats a real failure as a failure', () => {
    expect(classifyCreateError('fatal: repository not found')).toBe('failed')
  })
})

describe('setupProgressText', () => {
  it('renders provision:start with a 1-based counter', () => {
    // index 是 0 基的(workspaceSetup.ts: `let index = 0`,emit 后才 ++)。
    expect(setupProgressText({ type: 'provision:start', project: 'api', index: 0, total: 2 })).toBe(
      '正在拉取 api(1/2)',
    )
  })

  it('renders the last project as total/total, not total+1', () => {
    expect(setupProgressText({ type: 'provision', project: 'web', index: 1, total: 2 })).toBe(
      'web 好了(2/2)',
    )
  })

  it('surfaces a provision error verbatim instead of swallowing it', () => {
    expect(
      setupProgressText({ type: 'provision:error', project: 'api', index: 0, total: 1, message: '没权限' }),
    ).toBe('api 出错:没权限')
  })

  it('returns null for an event it does not render, so the last line stays put', () => {
    expect(setupProgressText({ type: 'hook:log' })).toBeNull()
  })
})

const OK_FORM: FormState = {
  online: true,
  missing: [],
  parent: '/Users/me/code',
  name: '新区',
  projectCount: 1,
  workflowId: 'standard',
  busy: false,
}

describe('whyNotCreate', () => {
  it('returns null when everything is filled in', () => {
    expect(whyNotCreate(OK_FORM)).toBeNull()
  })

  it('blocks when offline — a wizard that looks operable while offline is a lie', () => {
    expect(whyNotCreate({ ...OK_FORM, online: false })).toContain('没连上主机')
  })

  it('blocks and NAMES the channel the host does not advertise', () => {
    expect(whyNotCreate({ ...OK_FORM, missing: ['fs:browse'] })).toContain('fs:browse')
  })

  it('blocks while a creation is already in flight', () => {
    expect(whyNotCreate({ ...OK_FORM, busy: true })).toBe('正在创建…')
  })

  it('blocks with no parent directory chosen', () => {
    expect(whyNotCreate({ ...OK_FORM, parent: null })).toContain('目录')
  })

  it('surfaces the SPECIFIC name problem, not a generic 名字不对', () => {
    expect(whyNotCreate({ ...OK_FORM, name: 'a/b' })).toContain('/')
  })

  it('★blocks with zero projects — the zero-project create path was never confirmed', () => {
    expect(whyNotCreate({ ...OK_FORM, projectCount: 0 })).toContain('至少选一个项目')
  })

  it('blocks with no workflow chosen', () => {
    expect(whyNotCreate({ ...OK_FORM, workflowId: null })).toBe('选一个工作流')
  })

  it('reports being offline BEFORE complaining about the form: fix the connection first', () => {
    const broken: FormState = { ...OK_FORM, online: false, parent: null, name: '', projectCount: 0, workflowId: null }
    expect(whyNotCreate(broken)).toContain('没连上主机')
  })
})

describe('stageDisplayName', () => {
  it('prefers the stage own name', () => {
    expect(stageDisplayName({ key: 'develop', name: '照着方案写' })).toBe('照着方案写')
  })

  it('falls back to the built-in Chinese name for a built-in key', () => {
    expect(stageDisplayName({ key: 'review' })).toBe('代码 CR')
  })

  it('falls back to the raw key for an unknown custom stage', () => {
    expect(stageDisplayName({ key: 'my-custom-stage' })).toBe('my-custom-stage')
  })

  it('treats a blank name as no name (not as an empty label)', () => {
    expect(stageDisplayName({ key: 'test', name: '   ' })).toBe('写单测')
  })
})

describe('stageLabels', () => {
  it('keeps template order and resolves library references to their CURRENT definition', () => {
    const wf = {
      id: 'w',
      name: 'W',
      stages: [
        { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus' },
        // 模板里只冗余缓存了 key/name,name 还是库里的**老**名字
        { key: 'cust', libId: 'lib1', name: '旧名字', defaultAgent: 'claude', defaultModel: 'opus' },
      ],
    }
    const defs = {
      lib1: { id: 'lib1', key: 'lib1', name: '新名字', defaultAgent: 'codex', defaultModel: 'gpt' },
    }
    expect(stageLabels(wf, defs)).toEqual(['需求评估', '新名字'])
  })
})

describe('buildCreatePayload', () => {
  const wf = {
    id: 'standard',
    name: '标准工作流',
    stages: [
      { key: 'requirement', defaultAgent: 'claude', defaultModel: 'opus-4.8' },
      { key: 'develop', defaultAgent: 'codex', defaultModel: 'gpt-5', scope: 'per-project' as const },
    ],
  }

  it('renames defaultAgent/defaultModel to provider/model — the two shapes are NOT the same', () => {
    const out = buildCreatePayload({
      name: '新区',
      parent: '/Users/me/code',
      workflow: wf,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'feat/x' }],
    })
    expect(out.workflows[0].stages).toEqual([
      { key: 'requirement', provider: 'claude', model: 'opus-4.8' },
      { key: 'develop', provider: 'codex', model: 'gpt-5', scope: 'per-project' },
    ])
  })

  it('puts the workspace under the chosen PARENT — the folder itself is created by the host', () => {
    const out = buildCreatePayload({
      name: '新区',
      parent: '/Users/me/code',
      workflow: wf,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(out.path).toBe('/Users/me/code/新区')
    expect(out.name).toBe('新区')
  })

  it('sends exactly ONE workflow — the chosen one', () => {
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: wf,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(out.workflows).toHaveLength(1)
    expect(out.workflows[0].id).toBe('standard')
  })

  it('copies the develop stage agent onto every project, so no project ends up agent-less', () => {
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: wf,
      stageDefs: {},
      projects: [
        { repoId: 'p1', branch: 'feat/a' },
        { repoId: 'p2', branch: 'feat/b' },
      ],
    })
    expect(out.projects).toEqual([
      { repoId: 'p1', branch: 'feat/a', provider: 'codex', model: 'gpt-5' },
      { repoId: 'p2', branch: 'feat/b', provider: 'codex', model: 'gpt-5' },
    ])
  })

  it('falls back to empty provider/model when the template has no develop stage', () => {
    const noDev = { id: 'x', name: 'X', stages: [{ key: 'requirement', defaultAgent: 'claude', defaultModel: 'o' }] }
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: noDev,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(out.projects[0]).toEqual({ repoId: 'p1', branch: 'main', provider: '', model: '' })
  })

  it('★resolves libId stages before sending: an unresolved one loses its prompt SILENTLY', () => {
    const withLib = {
      id: 'x',
      name: 'X',
      stages: [{ key: 'cust', libId: 'lib1', name: '缓存的旧名字' }],
    }
    const defs = {
      lib1: {
        id: 'lib1',
        key: 'lib1',
        name: '真名字',
        defaultAgent: 'claude',
        defaultModel: 'opus',
        prompt: '按库里这段跑',
        scope: 'per-project' as const,
        gate: true,
      },
    }
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: withLib,
      stageDefs: defs,
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(out.workflows[0].stages[0]).toEqual({
      key: 'cust',
      provider: 'claude',
      model: 'opus',
      name: '真名字',
      prompt: '按库里这段跑',
      scope: 'per-project',
      gate: true,
    })
  })

  it('omits optional stage fields entirely rather than writing them as undefined', () => {
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: wf,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(Object.keys(out.workflows[0].stages[0]).sort()).toEqual(['key', 'model', 'provider'])
  })

  it('carries gate:false through — an explicit false is a real setting, not "unset"', () => {
    const gated = { id: 'x', name: 'X', stages: [{ key: 'design', defaultAgent: 'c', defaultModel: 'm', gate: false }] }
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: gated,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(out.workflows[0].stages[0]).toHaveProperty('gate', false)
  })

  it('★sends NO plugins and NO stepPlugins — setup hooks would open gates this screen cannot answer', () => {
    const out = buildCreatePayload({
      name: 'w',
      parent: '/p',
      workflow: wf,
      stageDefs: {},
      projects: [{ repoId: 'p1', branch: 'main' }],
    })
    expect(Object.keys(out).sort()).toEqual(['name', 'path', 'projects', 'workflows'])
  })
})

describe('filterProjects', () => {
  const list = [
    { name: 'api', alias: '后端', repoUrl: 'git@github.com:me/api.git' },
    { name: 'web', alias: '', repoUrl: 'git@github.com:me/web.git' },
  ]

  it('returns the SAME array reference for a blank query, not a fresh copy', () => {
    // ★`toHaveLength(2)` 在这里是假绿:`includes('')` 恒真,所以把这条捷径删掉,
    //  内容照样对(变异测试当场证明过)。要钉住的是**没有重建数组**这件事本身。
    expect(filterProjects(list, '   ')).toBe(list)
  })

  it('matches the name, case-insensitively', () => {
    expect(filterProjects(list, 'API').map((p) => p.name)).toEqual(['api'])
  })

  it('matches the alias, so a Chinese nickname finds it', () => {
    expect(filterProjects(list, '后端').map((p) => p.name)).toEqual(['api'])
  })

  it('matches the repo url', () => {
    expect(filterProjects(list, 'me/web').map((p) => p.name)).toEqual(['web'])
  })

  it('returns an empty list when nothing matches, rather than falling back to everything', () => {
    expect(filterProjects(list, 'zzz')).toEqual([])
  })

  it('survives projects with no alias/repoUrl at all', () => {
    expect(filterProjects([{ name: 'solo' }], 'sol').map((p) => p.name)).toEqual(['solo'])
  })
})
