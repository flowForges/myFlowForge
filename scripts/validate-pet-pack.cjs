const fs = require('node:fs')
const path = require('node:path')

const rootArg = process.argv[2]
if (!rootArg) {
  console.error('usage: node scripts/validate-pet-pack.cjs <pack-directory>')
  process.exit(2)
}

const root = path.resolve(rootArg)
const states = ['idle', 'working', 'confirm', 'input', 'done']
const required = states.flatMap(state => [
  `${state}.gif`,
  `webp/${state}.webp`,
  `apng/${state}.png`,
  `png/${state}.png`,
])
const missing = required.filter(rel => !fs.existsSync(path.join(root, rel)))
if (missing.length) {
  console.error(`missing pet assets:\n${missing.join('\n')}`)
  process.exit(1)
}
for (const rel of required) {
  if (fs.statSync(path.join(root, rel)).size === 0) {
    console.error(`empty pet asset: ${rel}`)
    process.exit(1)
  }
}
console.log(`validated ${required.length} assets in ${root}`)
