// 生成一个成长宠物占位包,用来在真美术到位前端到端验收整条链路。
// 用法: node scripts/make-growth-placeholder.mjs /tmp/growth-placeholder
// 然后在 设置 → 宠物 → 安装成长宠物包… 里选这个目录。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? '/tmp/growth-placeholder'
const COLS = 6
const ROWS = 3
const CELL = 120
// 6 个阶段:高度递增 + 颜色渐变,一眼能看出"长大了"。
const STAGES = [
  { at: 0,    name: '种子', h: 0.10, color: '#8d6e4f' },
  { at: 0.08, name: '破土', h: 0.20, color: '#7a9e5a' },
  { at: 0.20, name: '发芽', h: 0.35, color: '#6bbf59' },
  { at: 0.40, name: '树干', h: 0.55, color: '#4f9d46' },
  { at: 0.65, name: '开花', h: 0.75, color: '#e58bb0' },
  { at: 0.90, name: '结果', h: 0.95, color: '#e0603a' },
]
// 每一帧左右摆一点,让 idle/working/alert 三行肉眼可分辨。
const SWAY = [0, 2, 4, 2, 0, -2]
const ROW_SWAY = [1, 3, 6]   // idle 微摆 / working 摆得快而大 / alert 最大

function cell(col, row, stage) {
  const x = col * CELL, y = row * CELL
  const h = CELL * stage.h
  const dx = SWAY[col] * ROW_SWAY[row] * 0.5
  const cx = x + CELL / 2
  return `
    <rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" fill="none"/>
    <line x1="${cx}" y1="${y + CELL - 6}" x2="${cx + dx}" y2="${y + CELL - 6 - h}"
          stroke="${stage.color}" stroke-width="${6 + stage.h * 10}" stroke-linecap="round"/>
    <circle cx="${cx + dx}" cy="${y + CELL - 6 - h}" r="${4 + stage.h * 14}" fill="${stage.color}" opacity="0.85"/>`
}

function sheet(stage) {
  const cells = []
  for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) cells.push(cell(col, row, stage))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL}" height="${ROWS * CELL}" viewBox="0 0 ${COLS * CELL} ${ROWS * CELL}">${cells.join('')}</svg>`
}

mkdirSync(out, { recursive: true })
const stages = STAGES.map((s, i) => {
  const file = `${i}-${['seed', 'crack', 'sprout', 'trunk', 'bloom', 'fruit'][i]}.svg`
  writeFileSync(join(out, file), sheet(s))
  return { at: s.at, name: s.name, sheet: file }
})

writeFileSync(join(out, 'pet.json'), JSON.stringify({
  id: 'growth-placeholder',
  name: '成长树(占位)',
  kind: 'growth',
  signal: 'dailyTokens',
  atlas: { cols: COLS, cellW: CELL, cellH: CELL },
  actions: {
    idle:    { row: 0, durations: [280, 110, 110, 140, 140, 320] },
    working: { row: 1, durations: [120, 120, 120, 120, 120, 220] },
    alert:   { row: 2, durations: [150, 150, 150, 150, 150, 280] },
  },
  stages,
}, null, 2))

console.log(`占位包已生成: ${out}`)
