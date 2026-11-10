// 视觉核对用的静态页(08b R25)。只在 MFFAI_PREVIEW_OUT 设了时跑:
//   OUT=$(mktemp -d); MFFAI_PREVIEW_OUT=$OUT npx vitest run src/renderer/mffai/test/preview.test.tsx
// 每个任务把自己的屏加进来。
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writePreview } from './preview'
import { PREVIEW_SIZE, UI_DIFF, UI_ROWS, UI_TABLE } from './previewFixtures'
import { Chip, type ChipTone } from '../ui/Chip'
import { CodeChip } from '../ui/CodeChip'
import { AutoSwitch, UNSANDBOXED_AUTO_LABEL } from '../ui/AutoSwitch'
import { Countdown } from '../ui/Countdown'
import { DiffLines } from '../ui/DiffLines'
import { PathField } from '../ui/PathField'
import { Confirm } from '../ui/Confirm'

const OUT = process.env.MFFAI_PREVIEW_OUT
const TONES: ChipTone[] = ['ok', 'bad', 'warn', 'muted', 'run', 'acc', 'line']

function Controls() {
  return (
    <div className="mffai-page">
      <div className="mffai-tabs" role="tablist">
        <button className="set-btn active" role="tab">模型</button><button className="set-btn" role="tab">执行器</button><button className="set-btn" role="tab">Telegram</button>
      </div>
      <div className="mffai-row">
        <button className="set-btn mffai-primary">添加</button><button className="set-btn">测试</button><button className="set-btn mffai-danger">删除</button>
        <button className="set-btn" disabled>停用</button><button className="txt-btn">改动 3</button>
        <div className="mffai-seg"><button className="on">全部</button><button>本机</button><button>Telegram</button><button>定时</button></div>
        <span className="mffai-spin" />
      </div>
      {TONES.map((t) => (
        <div key={t} className="mffai-row"><Chip tone={t}>{t}</Chip><Chip tone={t} dot>{t}</Chip><Chip tone={t} sq>{t}</Chip><CodeChip code="crash-loop" /></div>
      ))}
      <div className="mffai-row">
        <input aria-label="地址" defaultValue="api.example.com" /><select aria-label="模型" defaultValue="a"><option value="a">GPT-5</option></select>
        <PathField value="~/work/forge-api" kind="directory" onChange={() => {}} />
      </div>
      <div className="mffai-card">
        <AutoSwitch checked onChange={() => {}} />
        <AutoSwitch checked={false} label={UNSANDBOXED_AUTO_LABEL} onChange={() => {}} />
        <label className="mffai-switch"><input type="checkbox" role="switch" defaultChecked />开机自启</label>
        <label className="mffai-switch"><input type="checkbox" role="switch" />主动推荐</label>
      </div>
      <div className="mffai-row"><Countdown from={Date.now() - 100_000} until={Date.now() + 200_000} /></div>
      <table className="mffai-tbl">
        <thead><tr><th>任务</th><th>执行器</th><th>状态</th><th>耗时</th></tr></thead>
        <tbody>{UI_TABLE.map((r) => <tr key={r.task}><td>{r.task}</td><td>{r.who}</td><td><Chip tone="run" dot>{r.state}</Chip></td><td>{r.time}</td></tr>)}</tbody>
      </table>
      <DiffLines diff={UI_DIFF} />
    </div>
  )
}

describe.skipIf(!OUT)('preview screens', () => {
  it('ui: shared controls', () => {
    render(<Controls />)
    writePreview('ui', PREVIEW_SIZE)
    const html = readFileSync(join(OUT!, 'ui.html'), 'utf8')
    expect(html).toContain('data-theme="dark"')
    expect(html).toContain('--mffai-knob')
    expect(html).toContain('.code-line')
  })

  it('ui-confirm: a confirm over the controls, light theme', () => {
    render(<><Controls /><Confirm title="合并" rows={UI_ROWS} keep={['分支 mffai/r_7f3a']} confirmLabel="合并" onCancel={() => {}} onConfirm={() => {}} /></>)
    writePreview('ui-confirm', { ...PREVIEW_SIZE, theme: 'light' })
    expect(existsSync(join(OUT!, 'ui-confirm.html'))).toBe(true)
  })
})
