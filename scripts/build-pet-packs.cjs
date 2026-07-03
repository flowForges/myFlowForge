const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'assets', 'pet-packs')
const W = 256
const H = 256
const FRAME_COUNT = 18
const GIF_DELAY_CS = 12
const STATES = ['idle', 'working', 'confirm', 'input', 'done']

const SOURCES = [
  ['china-dragon', '中国龙', '#ff00ff', '/Users/zghua/.codex/generated_images/019f22ff-32f4-7df2-9bca-b34ad2519fca/ig_054ce33004f2a00a016a466a6ee1548191a9e53590c9b32c18.png',
    'idle 盘卧微动；working 绕 8 字飞；confirm/input 朝屏幕扑近；done 从飞行收回盘卧。'],
  ['white-catgirl', '成年白系猫娘', '#00ff00', '/Users/zghua/.codex/generated_images/019f22ff-32f4-7df2-9bca-b34ad2519fca/ig_05e6356401873629016a466c1da38081919d9e523fff6bfcd5.png',
    '成年、白系、非色情半 Q 版；idle 来回走；working 坐在电脑前工作；confirm/input 面向屏幕跳起招手；done 侧躺睡觉。'],
  ['rocket-fox', '火箭狐', '#00ff00', '/Users/zghua/.codex/generated_images/019f22ff-32f4-7df2-9bca-b34ad2519fca/ig_07b317c21d05708e016a466d6803a08191aa2ff86bce4131d8.png',
    'idle 大步游走；working 火箭背包喷射巡航；confirm/input 扑向屏幕挥爪；done 蜷起休息。'],
  ['phoenix', '凤凰', '#00ff00', '/Users/zghua/.codex/generated_images/019f22ff-32f4-7df2-9bca-b34ad2519fca/ig_07b317c21d05708e016a466db00ebc8191b67b949b2fdc270e.png',
    'idle 振翼悬停；working 火焰弧线飞行；confirm/input 俯冲贴近；done 收翼停落。'],
  ['cyber-jellyfish', '赛博水母', '#ff00ff', '/Users/zghua/.codex/generated_images/019f22ff-32f4-7df2-9bca-b34ad2519fca/ig_07b317c21d05708e016a466dfd032481919ec53354b43eee8d.png',
    'idle 大幅漂浮；working 触手摆动操作终端；confirm/input 弹跳贴近；done 下沉睡眠。'],
]

const html = String.raw`
<!doctype html><meta charset="utf-8"><script>
const { ipcRenderer } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const ROOT = ${JSON.stringify(ROOT)}
const OUT = ${JSON.stringify(OUT)}
const W = ${W}, H = ${H}
const FRAME_COUNT = ${FRAME_COUNT}
const GIF_DELAY_CS = ${GIF_DELAY_CS}
const STATES = ${JSON.stringify(STATES)}
const SOURCES = ${JSON.stringify(SOURCES)}

function mkdir(p) { fs.mkdirSync(p, { recursive: true }) }
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function canvas(w = W, h = H) {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  return c
}
function load(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('load failed: ' + src))
    img.src = 'file://' + src
  })
}
function writeDataUrl(file, dataUrl) {
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
}
function trimAlpha(c) {
  const ctx = c.getContext('2d')
  const data = ctx.getImageData(0, 0, c.width, c.height).data
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (data[(y * c.width + x) * 4 + 3] > 18) {
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
  }
  return { minX, minY, maxX, maxY, w: Math.max(1, maxX - minX + 1), h: Math.max(1, maxY - minY + 1) }
}
function cutout(img, keyHex) {
  const src = canvas(img.naturalWidth, img.naturalHeight)
  const sctx = src.getContext('2d')
  sctx.drawImage(img, 0, 0)
  const im = sctx.getImageData(0, 0, src.width, src.height)
  const [kr, kg, kb] = hexToRgb(keyHex)
  for (let i = 0; i < im.data.length; i += 4) {
    const dr = im.data[i] - kr, dg = im.data[i + 1] - kg, db = im.data[i + 2] - kb
    const d = Math.sqrt(dr * dr + dg * dg + db * db)
    if (d < 115) im.data[i + 3] = 0
    else if (d < 190) im.data[i + 3] = Math.min(im.data[i + 3], Math.round((d - 115) / 75 * 255))
    if (im.data[i + 3] < 255 && (Math.abs(dg) < 170 || Math.abs(db) < 170)) {
      im.data[i] = Math.min(255, im.data[i] * 1.03)
      im.data[i + 1] = keyHex === '#00ff00' ? Math.min(im.data[i + 1], (im.data[i] + im.data[i + 2]) / 2 + 28) : im.data[i + 1]
      im.data[i + 2] = keyHex === '#ff00ff' ? Math.min(im.data[i + 2], (im.data[i] + im.data[i + 1]) / 2 + 28) : im.data[i + 2]
    }
  }
  sctx.putImageData(im, 0, 0)
  const box = trimAlpha(src)
  const out = canvas(W, H)
  const scale = Math.min(210 / box.w, 210 / box.h)
  const dw = box.w * scale, dh = box.h * scale
  out.getContext('2d').drawImage(src, box.minX, box.minY, box.w, box.h, (W - dw) / 2, (H - dh) / 2, dw, dh)
  return out
}
function stateMotion(pet, state, f, n) {
  const t = f / n, wave = Math.sin(t * Math.PI * 2)
  const m = { x: 0, y: 0, scale: 1, rot: 0, flip: false, alpha: 1 }
  if (state === 'idle') {
    m.y = wave * 14
    m.x = pet === 'white-catgirl' ? wave * 58 : wave * 18
    m.rot = wave * (pet === 'phoenix' ? 12 : 6) * Math.PI / 180
    m.flip = pet === 'white-catgirl' && f >= n / 2
  } else if (state === 'working') {
    if (pet === 'china-dragon') { m.x = Math.sin(t * Math.PI * 2) * 58; m.y = Math.sin(t * Math.PI * 4) * 34; m.rot = wave * .42 }
    else if (pet === 'phoenix') { m.x = Math.sin(t * Math.PI * 2) * 54; m.y = Math.cos(t * Math.PI * 2) * 42; m.rot = wave * .34 }
    else if (pet === 'rocket-fox') { m.x = -62 + t * 124; m.y = wave * 30; m.rot = -0.32 + wave * .18 }
    else { m.x = wave * 32; m.y = Math.cos(t * Math.PI * 2) * 26; m.rot = wave * .16 }
  } else if (state === 'confirm' || state === 'input') {
    const q = Math.sin(t * Math.PI)
    m.scale = 0.78 + q * 0.62
    m.y = -q * 32
    m.rot = wave * .24
    m.x = state === 'input' ? wave * 34 : wave * 18
  } else if (state === 'done') {
    m.scale = 1.08 - Math.sin(t * Math.PI) * .16
    m.y = pet === 'cyber-jellyfish' ? 28 + wave * 10 : 14 + wave * 7
    m.rot = (pet === 'white-catgirl' || pet === 'rocket-fox') ? -0.58 + wave * .08 : wave * .08
  }
  return m
}
function overlay(ctx, pet, state, f, n) {
  const t = f / n, wave = Math.sin(t * Math.PI * 2)
  ctx.save()
  if (state === 'working' && pet === 'white-catgirl') {
    ctx.fillStyle = 'rgba(38,44,64,.92)'; roundRect(ctx, 66, 158, 124, 62, 12); ctx.fill()
    ctx.fillStyle = 'rgba(76,180,255,.9)'; roundRect(ctx, 82, 170, 92, 28, 7); ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(92 + wave * 8, 181, 22, 3)
  }
  if (state === 'working' && pet === 'cyber-jellyfish') {
    ctx.strokeStyle = 'rgba(80,235,255,.9)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(196, 80, 18 + wave * 5, 0, Math.PI * 2); ctx.stroke()
  }
  if (state === 'working' && pet === 'rocket-fox') flame(ctx, 56, 174, 26 + wave * 10)
  if ((state === 'confirm' || state === 'input')) {
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(128, 128, 62 + Math.sin(t * Math.PI) * 46, 0, Math.PI * 2); ctx.stroke()
  }
  if (state === 'done') {
    ctx.fillStyle = 'rgba(40,44,60,.85)'
    ctx.font = 'bold 32px sans-serif'
    ctx.fillText('Z', 184, 58 + wave * 4); ctx.fillText('z', 208, 38 + wave * 3)
  }
  ctx.restore()
}
function flame(ctx, x, y, size) {
  ctx.fillStyle = 'rgba(255,207,70,.9)'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - size, y + size * .4); ctx.lineTo(x - size * .25, y - size * .55); ctx.closePath(); ctx.fill()
  ctx.fillStyle = 'rgba(255,90,40,.8)'; ctx.beginPath(); ctx.moveTo(x + 3, y + 6); ctx.lineTo(x - size * .7, y + size * .2); ctx.lineTo(x - size * .15, y - size * .35); ctx.closePath(); ctx.fill()
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
function compose(base, pet, state, f, n) {
  const out = canvas(W, H), ctx = out.getContext('2d')
  const m = stateMotion(pet, state, f, n)
  ctx.save()
  ctx.globalAlpha = m.alpha
  ctx.translate(W / 2 + m.x, H / 2 + m.y)
  ctx.rotate(m.rot)
  ctx.scale((m.flip ? -1 : 1) * m.scale, m.scale)
  ctx.drawImage(base, -W / 2, -H / 2)
  ctx.restore()
  overlay(ctx, pet, state, f, n)
  return out
}
function rgba(c) { return c.getContext('2d').getImageData(0, 0, W, H).data }

const pal = [[0,0,0]]
for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) pal.push([Math.round(r * 51), Math.round(g * 51), Math.round(b * 51)])
while (pal.length < 256) pal.push([0,0,0])
function nearest(r,g,b) {
  let best = 1, bd = 1e9
  for (let i=1;i<217;i++) { const p=pal[i], d=(r-p[0])**2+(g-p[1])**2+(b-p[2])**2; if (d<bd) { bd=d; best=i } }
  return best
}
function idx(data) {
  const out = new Uint8Array(W*H)
  for (let i=0,p=0;i<data.length;i+=4,p++) out[p] = data[i+3] < 64 ? 0 : nearest(data[i],data[i+1],data[i+2])
  return out
}
function crc32(buf) { let c=~0; for (const b of buf){ c^=b; for(let k=0;k<8;k++) c=(c>>>1)^(0xedb88320&-(c&1)) } return ~c>>>0 }
function lzw(indices) {
  const clear=256,end=257; let size=9,next=258,cur=0,bits=0; const dict=new Map(), bytes=[]
  const reset=()=>{dict.clear(); for(let i=0;i<256;i++) dict.set(String.fromCharCode(i),i); size=9; next=258}
  const code=c=>{cur|=c<<bits; bits+=size; while(bits>=8){bytes.push(cur&255); cur>>>=8; bits-=8}}
  reset(); code(clear); let w=String.fromCharCode(indices[0])
  for(let i=1;i<indices.length;i++){const k=String.fromCharCode(indices[i]), wk=w+k; if(dict.has(wk)) w=wk; else {code(dict.get(w)); if(next<4096){dict.set(wk,next++); if(next===(1<<size)&&size<12) size++} else {code(clear); reset()} w=k}}
  code(dict.get(w)); code(end); if(bits) bytes.push(cur&255); return Buffer.from(bytes)
}
function subblocks(data) { const a=[]; for(let i=0;i<data.length;i+=255) a.push(Buffer.from([Math.min(255,data.length-i)]), data.subarray(i,i+255)); a.push(Buffer.from([0])); return Buffer.concat(a) }
function gif(frames) {
  const lsd=Buffer.alloc(7); lsd.writeUInt16LE(W,0); lsd.writeUInt16LE(H,2); lsd[4]=0xf7
  const gct=Buffer.from(pal.flat())
  const parts=[Buffer.from('GIF89a','ascii'),lsd,gct,Buffer.from([0x21,0xff,0x0b,...Buffer.from('NETSCAPE2.0'),0x03,0x01,0,0,0])]
  for (const frame of frames) {
    const gce=Buffer.from([0x21,0xf9,0x04,0x09,GIF_DELAY_CS,0,0,0])
    const id=Buffer.alloc(10); id[0]=0x2c; id.writeUInt16LE(W,5); id.writeUInt16LE(H,7)
    parts.push(gce,id,Buffer.from([8]),subblocks(lzw(idx(rgba(frame)))))
  }
  parts.push(Buffer.from([0x3b])); return Buffer.concat(parts)
}

(async () => {
  try {
    fs.rmSync(OUT, { recursive: true, force: true }); mkdir(OUT)
    const manifest = { states: STATES, size: '256x256', transparent: true, pets: [] }
    for (const [id, name, key, src, description] of SOURCES) {
      const dir = path.join(OUT, id); mkdir(dir)
      fs.copyFileSync(src, path.join(dir, 'source.png'))
      const base = cutout(await load(src), key)
      mkdir(path.join(dir, 'png'))
      mkdir(path.join(dir, 'webp'))
      writeDataUrl(path.join(dir, 'base.png'), base.toDataURL('image/png'))
      const files = {}
      for (const state of STATES) {
        const frames = Array.from({length: FRAME_COUNT}, (_, i) => compose(base, id, state, i, FRAME_COUNT))
        fs.writeFileSync(path.join(dir, state + '.gif'), gif(frames))
        writeDataUrl(path.join(dir, 'png', state + '.png'), frames[0].toDataURL('image/png'))
        writeDataUrl(path.join(dir, 'webp', state + '.webp'), frames[0].toDataURL('image/webp', .92))
        files[state] = { gif: state + '.gif', png: 'png/' + state + '.png', webp: 'webp/' + state + '.webp' }
      }
      fs.writeFileSync(path.join(dir, 'README.md'), '# ' + name + '\n\n' + description + '\n\n根目录的 idle/working/confirm/input/done.gif 是可直接导入的动图宠物包。png/ 和 webp/ 子目录保留对应静态首帧备用图。\n')
      manifest.pets.push({ id, name, description, files })
    }
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    ipcRenderer.send('done')
  } catch (err) {
    ipcRenderer.send('fail', err && err.stack || String(err))
  }
})()
</script>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, webSecurity: false } })
  ipcMain.once('done', () => { console.log(`built pet packs in ${OUT}`); app.quit() })
  ipcMain.once('fail', (_e, msg) => { console.error(msg); app.exit(1) })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
})
