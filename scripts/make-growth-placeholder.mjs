// 生成一个成长宠物占位包,用来在真美术到位前端到端验收整条链路。
// 用法: node scripts/make-growth-placeholder.mjs ~/growth-placeholder
// 然后在 设置 → 宠物 → 安装成长宠物包… 里选这个目录。重装同一个目录 = 升级(id 按源目录稳定生成)。
//
// ★每一格都先画土,植物长在土里 —— 第一版把种子画成一根悬在半空的短线,既不像种子也不像"在长",
// 一眼就露馅。土带同时起到视觉锚点的作用:六个阶段的地平线一致,长高才看得出来。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? '/tmp/growth-placeholder'
const COLS = 6
const ROWS = 3
const CELL = 120

// 土带在格子底部占多高。植物从 SOIL 这条线往上长,种子则半埋在线下。
const SOIL = CELL - 26

const C = {
  soil: '#5d4230', soilTop: '#7a5a3e', mound: '#6b4b34',
  seed: '#c8a06a', shoot: '#7bbf5a', stem: '#5fa84a', leaf: '#79c65f',
  trunk: '#7a5a3a', canopy: '#4f9d46', bloom: '#f0a0c0', fruit: '#e0603a',
}

// 每帧的摆动幅度(像素),乘以行系数。idle 微摆 / working 摆得快而大 / alert 最大。
const SWAY = [0, 1, 2, 1, 0, -1]
const ROW_SWAY = [1, 3, 6]

const g = (s) => s.filter(Boolean).join('')

// 土:一条实心土带 + 稍亮的表层 + 中间一个小土丘(把植物"种"在丘上,不是浮在线上)。
function ground() {
  return `
    <rect x="0" y="${SOIL}" width="${CELL}" height="${CELL - SOIL}" fill="${C.soil}"/>
    <rect x="0" y="${SOIL}" width="${CELL}" height="3" fill="${C.soilTop}"/>
    <ellipse cx="${CELL / 2}" cy="${SOIL + 2}" rx="22" ry="6" fill="${C.mound}"/>`
}

// 一根从土丘长出的茎。dx = 顶端偏移(摆动),w = 粗细,h = 高度。
function stem(h, w, dx, color) {
  const x0 = CELL / 2, y0 = SOIL + 1
  return `<path d="M${x0} ${y0} Q ${x0 + dx * 0.4} ${y0 - h * 0.55} ${x0 + dx} ${y0 - h}"
    stroke="${color}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`
}

// 一对叶子,挂在茎上 frac 高度处。
function leaves(h, dx, frac, size) {
  const x = CELL / 2 + dx * frac, y = SOIL + 1 - h * frac
  return `
    <ellipse cx="${x - size}" cy="${y}" rx="${size}" ry="${size * 0.55}" fill="${C.leaf}" transform="rotate(-18 ${x - size} ${y})"/>
    <ellipse cx="${x + size}" cy="${y}" rx="${size}" ry="${size * 0.55}" fill="${C.leaf}" transform="rotate(18 ${x + size} ${y})"/>`
}

// 两根斜枝 + 树冠,给"树"用。
function branches(h, dx) {
  const x = CELL / 2, top = SOIL + 1 - h
  return `
    <path d="M${x + dx * 0.5} ${top + h * 0.42} l -13 -10" stroke="${C.trunk}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M${x + dx * 0.6} ${top + h * 0.28} l 13 -10" stroke="${C.trunk}" stroke-width="3.5" stroke-linecap="round"/>`
}

// 每个阶段画什么。h 是植物高度(像素),越往后越高。
const STAGES = [
  {
    at: 0, name: '种子', file: '0-seed.svg',
    // 半埋在土里:先画整颗种子,再用土带盖住下半部分 —— 读起来就是"种下去了"。
    draw: () => `
      <ellipse cx="${CELL / 2}" cy="${SOIL + 1}" rx="9" ry="11" fill="${C.seed}"/>
      <ellipse cx="${CELL / 2 - 3}" cy="${SOIL - 2}" rx="3" ry="4" fill="#e0c093" opacity=".7"/>
      <rect x="0" y="${SOIL + 1}" width="${CELL}" height="${CELL - SOIL}" fill="${C.soil}"/>
      <ellipse cx="${CELL / 2}" cy="${SOIL + 2}" rx="16" ry="5" fill="${C.mound}"/>`,
  },
  {
    at: 0.08, name: '破土', file: '1-crack.svg',
    // 土丘裂开,一点嫩芽冒头。
    draw: (dx) => g([
      `<path d="M${CELL / 2 - 12} ${SOIL + 3} l 8 -5 M${CELL / 2 + 12} ${SOIL + 3} l -8 -5"
        stroke="${C.soilTop}" stroke-width="2.5" stroke-linecap="round"/>`,
      stem(12, 4, dx * 0.5, C.shoot),
      `<circle cx="${CELL / 2 + dx * 0.5}" cy="${SOIL - 11}" r="4" fill="${C.leaf}"/>`,
    ]),
  },
  {
    at: 0.20, name: '发芽', file: '2-sprout.svg',
    draw: (dx) => g([stem(30, 4.5, dx, C.stem), leaves(30, dx, 0.95, 8)]),
  },
  {
    at: 0.40, name: '树干', file: '3-trunk.svg',
    draw: (dx) => g([
      stem(52, 8, dx, C.trunk), branches(52, dx),
      `<ellipse cx="${CELL / 2 + dx}" cy="${SOIL - 53}" rx="20" ry="14" fill="${C.canopy}"/>`,
    ]),
  },
  {
    at: 0.65, name: '开花', file: '4-bloom.svg',
    draw: (dx) => g([
      stem(66, 10, dx, C.trunk), branches(66, dx),
      `<ellipse cx="${CELL / 2 + dx}" cy="${SOIL - 68}" rx="28" ry="19" fill="${C.canopy}"/>`,
      [[-16, -74], [10, -80], [-2, -62], [20, -66]]
        .map(([ox, oy]) => `<circle cx="${CELL / 2 + dx + ox}" cy="${SOIL + oy}" r="5" fill="${C.bloom}"/>`).join(''),
    ]),
  },
  {
    at: 0.90, name: '结果', file: '5-fruit.svg',
    draw: (dx) => g([
      stem(78, 11, dx, C.trunk), branches(78, dx),
      `<ellipse cx="${CELL / 2 + dx}" cy="${SOIL - 80}" rx="33" ry="23" fill="${C.canopy}"/>`,
      [[-18, -84], [12, -90], [0, -70], [24, -76]]
        .map(([ox, oy]) => `<circle cx="${CELL / 2 + dx + ox}" cy="${SOIL + oy}" r="6" fill="${C.fruit}"/>`).join(''),
    ]),
  },
]

function sheet(stage) {
  const cells = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const dx = SWAY[col] * ROW_SWAY[row]
      // 每格一个 translate,格内用局部坐标 —— 比到处手算绝对坐标好读也好改。
      cells.push(`<g transform="translate(${col * CELL} ${row * CELL})">${ground()}${stage.draw(dx)}</g>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * CELL}" height="${ROWS * CELL}" viewBox="0 0 ${COLS * CELL} ${ROWS * CELL}">${cells.join('')}</svg>`
}

mkdirSync(out, { recursive: true })
const stages = STAGES.map(s => {
  writeFileSync(join(out, s.file), sheet(s))
  return { at: s.at, name: s.name, sheet: s.file }
})

writeFileSync(join(out, 'pet.json'), JSON.stringify({
  id: 'growth-placeholder',
  name: '成长树(占位)',
  kind: 'growth',
  signal: 'dailyTokens',
  atlas: { cols: COLS, cellW: CELL, cellH: CELL },
  // durations 的长度就是该行的帧数,必须 ≤ atlas.cols(校验器会拒)。这里正好等于 6,没有余量 ——
  // 想加第 7 帧就得同时把 COLS 调大。
  actions: {
    idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
    working: { row: 1, durations: [120, 120, 120, 120, 120, 220] },
    alert: { row: 2, durations: [150, 150, 150, 150, 150, 280] },
  },
  stages,
}, null, 2))

console.log(`占位包已生成: ${out}`)
