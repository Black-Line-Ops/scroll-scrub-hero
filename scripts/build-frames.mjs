/* Step 4: segment videos -> the numbered WebP frames the page scrubs, plus config.js.
   This is the step that decides page weight, so it measures and reports rather than leaving
   you to discover a 60 MB hero after deploying it. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { state, args } from './kie.mjs'

const a = args()
if (!a.segments || !a.storyboard || !a.out) {
  console.error('usage: node build-frames.mjs --segments segments/ --storyboard storyboard.json --out <site>/assets/hero-scroll/frames/\n' +
    '                          [--width 1600] [--per-clip 40] [--quality 78] [--budget-mb 35] [--var HERO]')
  process.exit(1)
}

const sb = JSON.parse(fs.readFileSync(a.storyboard, 'utf8'))
const segState = state.load(path.join(a.segments, '_state.json'))
const width = parseInt(a.width || '1600', 10)
const perClip = parseInt(a['per-clip'] || '40', 10)
const quality = parseInt(a.quality || '78', 10)
const budgetMb = parseFloat(a['budget-mb'] || '35')
const prefix = a.var || 'HERO'
const outDir = a.out

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
  'format=duration:stream=width,height,nb_frames', '-of', 'json', f], { encoding: 'utf8' }))

/* Resolve each recorded file against the segments directory. Older state files stored a
   CWD-relative path, so fall back to the raw value for backward compatibility. */
const segDir = path.resolve(a.segments)
const segments = Object.values(segState.segments || {})
  .map(s => {
    const cands = [s.file && path.resolve(segDir, path.basename(s.file)), s.file && path.resolve(s.file)].filter(Boolean)
    return { ...s, file: cands.find(p => fs.existsSync(p)) || null }
  })
  .filter(s => s.file)
  .sort((x, y) => x.from - y.from)

if (!segments.length) { console.error(`no completed segments in ${a.segments}`); process.exit(1) }

/* Identical segments mean the same tween landed twice - a stale file from a resumed run, or
   placeholder/test footage that was never replaced. The finished hero would replay the same
   motion, which is easy to miss in a contact sheet and obvious once it is live. */
{
  const seen = new Map()
  for (const s of segments) {
    const h = createHash('md5').update(fs.readFileSync(s.file)).digest('hex')
    if (seen.has(h)) {
      console.log(`  !! ${path.basename(s.file)} is byte-identical to ${path.basename(seen.get(h))} —`)
      console.log('     the same motion will play twice. Placeholder footage, or a stale file from a resumed run?')
    } else seen.set(h, s.file)
  }
}

fs.mkdirSync(outDir, { recursive: true })
const seq = []
let totalBytes = 0

for (let i = 0; i < segments.length; i++) {
  const seg = segments[i]
  const dir = path.join(outDir, `clip${i + 1}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const meta = probe(seg.file)
  const dur = parseFloat(meta.format?.duration || seg.duration || 5)
  /* Sample an even spread rather than taking the first N frames, so the clip covers the whole
     motion. fps = frames wanted / seconds available. */
  const fps = (perClip / dur).toFixed(6)

  console.log(`clip${i + 1}  <- ${path.basename(seg.file)}  ${dur.toFixed(2)}s -> ${perClip} frames @ ${width}px`)
  ff(['-i', seg.file,
    '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`,
    '-vsync', '0',
    '-c:v', 'libwebp', '-quality', String(quality), '-preset', 'picture',
    path.join(dir, 'frame-%04d.webp')])

  let files = fs.readdirSync(dir).filter(f => f.endsWith('.webp')).sort()
  /* fps sampling can land one over or under; normalise so config.js and disk agree exactly,
     because the page indexes frames by number and a missing file is a broken scrub */
  while (files.length > perClip) {
    fs.rmSync(path.join(dir, files.pop()))
  }
  while (files.length && files.length < perClip) {
    const src = path.join(dir, files[files.length - 1])
    const dst = path.join(dir, `frame-${String(files.length + 1).padStart(4, '0')}.webp`)
    fs.copyFileSync(src, dst)
    files.push(path.basename(dst))
  }

  /* Zero frames means ffmpeg produced nothing - a corrupt download, or a build without
     libwebp. Writing n:0 into config and exiting 0 would ship a hero with a dead chapter
     and no error anywhere, so stop here instead. */
  if (!files.length) {
    console.error(`\n  !! clip${i + 1} produced no frames from ${path.basename(seg.file)}.`)
    console.error('     Usually the segment is corrupt, or this ffmpeg has no libwebp encoder.')
    console.error('     Check:  ffmpeg -hide_banner -encoders | grep -i webp')
    process.exit(1)
  }

  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
  totalBytes += bytes
  const dest = sb.steps.find(s => s.id === seg.to) || {}
  seq.push({
    dir: `clip${i + 1}`,
    n: files.length,
    k: `${String(i + 1).padStart(2, '0')} · ${dest.label || 'Step ' + (i + 1)}`,
    t: dest.caption || '',
  })
  console.log(`         ${files.length} frames, ${(bytes / 1048576).toFixed(1)} MB ` +
    `(${Math.round(bytes / files.length / 1024)} KB/frame)`)
}

const cfg = `window.${prefix}_EXT="webp";\nwindow.${prefix}_SEQ=[\n` +
  seq.map(s => '  ' + JSON.stringify(s) + ',').join('\n') +
  '\n];\n'
fs.writeFileSync(path.join(outDir, 'config.js'), cfg)

const mb = totalBytes / 1048576
console.log(`\nwrote ${seq.length} clips, ${seq.reduce((n, s) => n + s.n, 0)} frames, ${mb.toFixed(1)} MB total`)
console.log(`config: ${path.join(outDir, 'config.js')}`)

if (mb > budgetMb) {
  console.log(`\n  !! ${mb.toFixed(1)} MB is over the ${budgetMb} MB budget.`)
  console.log('     Every frame is fetched and decoded by the browser, so this is felt on first load.')
  console.log(`     Try --per-clip ${Math.max(24, Math.floor(perClip * budgetMb / mb))} or --width ${Math.round(width * 0.8)} or --quality ${Math.max(60, quality - 10)}.`)
} else {
  console.log(`within the ${budgetMb} MB budget.`)
}
console.log('\nIf the page already reads this config, reload and scrub it. Otherwise see references/hero-wiring.md.')
