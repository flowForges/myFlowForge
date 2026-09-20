import net from 'node:net'
import { rmSync } from 'node:fs'
import { needsAuth } from '../../shared/authPolicy'

/**
 * 授权中枢 —— 所有「要不要放这条操作过去」的请求都汇到这里。
 *
 * ★★设计要点:**它不自己定义一套权限**,而是复用 app 已经有的那道门(handlers 的 toolConfirm)。
 *  于是「完全访问档自动放行」「工具卡上那枚 🛡」「运行中改档立即兑现」这些行为全部免费继承,
 *  绝不会出现「两套权限语义各说各话」——那是这类中间层最容易长出来的毛病。
 *
 * ★现在的来源只有 PATH shim(commandShim.ts);以后 gemini/qwen 的 hook 接进来时,
 *  加一个 `type` 分支即可,门那一侧一行都不用动。
 * ★★任何认不出的东西一律 **deny**:这一层的存在意义就是「没问过就不许跑」,
 *  出错时放行等于它从未存在过。
 */

export interface AuthConfirmReq { title: string; where?: string; sessionId: string }
export interface AuthBrokerDeps {
  confirm(req: AuthConfirmReq): Promise<'allow' | 'deny'>
}
export interface AuthBroker {
  socketPath: string
  close(): Promise<void>
}

interface ExecReq { type?: string; sessionId?: string; command?: string; argv?: string[]; cwd?: string }

export function startAuthBroker(socketPath: string, deps: AuthBrokerDeps): Promise<AuthBroker> {
  return new Promise((resolve, reject) => {
    const isPipe = socketPath.startsWith('\\\\.\\pipe\\')
    if (!isPipe) { try { rmSync(socketPath, { force: true }) } catch { /* 首次运行,本来就没有 */ } }

    const server = net.createServer((socket) => {
      let buf = ''
      socket.on('error', () => { /* agent 半路被杀,连接断了是常态 */ })
      socket.on('data', (d) => {
        buf += d.toString()
        let nl: number
        // ★逐行处理:一个 shim 一条请求,但同一轮里可能有好几个 shim 并发连上来。
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          void handle(line).then((r) => { try { socket.write(JSON.stringify(r) + '\n') } catch { /* 对面没了 */ } })
        }
      })
    })

    async function handle(line: string): Promise<{ decision: 'allow' | 'deny'; message?: string }> {
      let req: ExecReq
      try { req = JSON.parse(line) as ExecReq } catch { return { decision: 'deny', message: '请求解析失败' } }
      if (req.type !== 'exec' || !req.command) return { decision: 'deny', message: '不认识的授权请求' }
      const argv = Array.isArray(req.argv) ? req.argv.map(String) : []
      const need = needsAuth(req.command, argv)
      // ★不需要授权的直接过,**连门都不弹**。`git status` 一轮跑十几次,弹一次用户就切回完全访问档了。
      if (!need) return { decision: 'allow' }
      try {
        const d = await deps.confirm({
          title: `${need.title} · ${need.reason}`,
          // 完整命令一定要摆出来:用户点「允许」之前有权看见到底要跑什么。
          where: [req.command, ...argv].join(' '),
          sessionId: req.sessionId ?? '',
        })
        return d === 'allow' ? { decision: 'allow' } : { decision: 'deny', message: '你在 Forge 里拒绝了这次执行' }
      } catch {
        // ★门抛异常(UI 被拆掉、会话没了)→ deny。绝不能因为界面出问题就把不可逆的命令放出去。
        return { decision: 'deny', message: 'Forge 的确认门不可用' }
      }
    }

    server.on('error', reject)
    server.listen(socketPath, () => resolve({
      socketPath,
      close: () => new Promise<void>((done) => server.close(() => {
        if (!isPipe) { try { rmSync(socketPath, { force: true }) } catch { /* 已经没了 */ } }
        done()
      })),
    }))
  })
}
