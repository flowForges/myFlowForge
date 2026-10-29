export interface PermissionRequest {
  actor: 'kernel' | string
  action: string
  resource?: string
}

// 本期默认策略:内核自身 allow,其余 deny。规则引擎后续替换,接口不变
export class PermissionGate {
  check(req: PermissionRequest): 'allow' | 'deny' | 'ask' {
    return req.actor === 'kernel' ? 'allow' : 'deny'
  }
}
