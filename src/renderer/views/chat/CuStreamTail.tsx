// 消息流末尾的电脑操作:本会话的记录块 + 挂着的批准卡。看远程主机时一概不渲染,浮窗是唯一的批准面(spec V2)。
import type { ComputerUseApi } from '../../state/useComputerUse'
import { CuGateCard } from './CuGateCard'
import { CuLogBlock } from './CuLogBlock'

export function CuStreamTail({ remote, gates, gateErrors, log, resolve, thumb }: { remote: boolean } & Pick<ComputerUseApi, 'gates' | 'gateErrors' | 'log' | 'resolve' | 'thumb'>) {
  if (remote || (!gates.length && !log.length)) return null
  return (
    <>
      <CuLogBlock entries={log} thumb={thumb} />
      {gates.map((g) => <CuGateCard key={g.id} gate={g} error={gateErrors[g.id]} onResolve={resolve} />)}
    </>
  )
}
