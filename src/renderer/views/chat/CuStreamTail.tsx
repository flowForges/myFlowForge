// 消息流末尾的电脑操作:挂着的批准卡。看远程主机时一概不渲染,浮窗是唯一的批准面(spec V2)。
// rc3:各轮的记录块不在这里了,它们编进消息流、落在各自那一轮之后(cuAnchor.ts + CuTurnBlock)。
import type { ComputerUseApi } from '../../state/useComputerUse'
import { CuGateCard } from './CuGateCard'

export function CuStreamTail({ remote, gates, gateErrors }: { remote: boolean } & Pick<ComputerUseApi, 'gates' | 'gateErrors'>) {
  if (remote || !gates.length) return null
  return <>{gates.map((g) => <CuGateCard key={g.id} gate={g} error={gateErrors[g.id]} />)}</>
}
