export function DeleteConfirm({ name, purges, onCancel, onConfirm }: { name: string; purges: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="confirm-overlay on" onClick={onCancel}>
      <div className="confirm-card" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="confirm-k">Danger zone</div>
        <div className="confirm-title">永久删除工作区？</div>
        <div className="confirm-copy">{purges ? '这会删除工作区里的文件、代码、会话记录和本地缓存，无法恢复。普通归档不会删除这些内容。' : '这是导入的工作区，只会从列表移除索引条目，不会删除你本机仓库里的任何文件。'}</div>
        <div className="confirm-name">{name}</div>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>取消</button>
          <button className="confirm-danger" onClick={onConfirm}>确认永久删除</button>
        </div>
      </div>
    </div>
  )
}
