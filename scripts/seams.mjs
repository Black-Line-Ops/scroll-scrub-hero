/* Step 5b: look at the deliverable.

   Everything else in this repo is upstream of the artifact. The argument parser is tested, the
   retry policy is tested, the rate table tests itself - and the one thing that actually goes wrong,
   a visible jump cut where two clips meet, was checked by a human scrolling a page and squinting.

   THE SEAM. Kling renders each segment FROM keyframe N TO keyframe N+1, so the last frame of clipN
   and the first frame of clip(N+1) are both meant to be keyframe N+1. When the model loses
   continuity they are not, and the page cuts. That is the failure this whole pipeline is designed
   around, and it is measurable without a browser: two files on disk, one ffmpeg call.

   WHY AN ABSOLUTE THRESHOLD WOULD LIE. The obvious version of this check picks a number - "SSIM
   below 0.9 is a cut" - and it is wrong in both directions. Shingles, foliage, gravel and water
   shimmer between consecutive frames even when the camera has not moved a pixel, so detailed
   footage scores low everywhere and every seam trips. Flat footage - a wall, an overcast sky -
   scores high everywhere, and a genuine cut can sit above the line. A fixed threshold measures the
   subject, not the seam.

   So the baseline comes from the run itself: sample ordinary frame-to-frame steps INSIDE the clips,
   where by construction there is no seam, and take the median. That number is this footage's normal
   amount of change. A seam is then judged as a ratio against it - "this join is 0.45x as smooth as
   an ordinary step in this same material" - which is both self-calibrating and the sentence you
   would want to read.

   What it cannot do: judge composition. A seam can be pixel-similar and still read wrong because
   the light shifted or a wall moved a metre. That still needs eyes. This finds the ones eyes would
   also find, ranks them, and names the exact command to fix the worst - which is the part that was
   missing. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { args } from './kie.mjs'

const a = args(process.argv.slice(2), { booleans: ['strict'], numbers: ['samples'] })
if (typeof a.frames !== 'string') {
  console.error('usage: node seams.mjs --frames <site>/assets/hero-scroll/frames/ [--samples 5] [--strict]')
  console.error('       reads the clipN/ directories build-frames.mjs wrote and measures every join.')
  console.error('       --strict exits non-zero when a join looks like a visible cut.')
  process.exit(1)
}
const framesDir = path.resolve(a.frames)
if (!fs.existsSync(framesDir)) { console.error(`no such directory: ${framesDir}`); process.exit(1) }

/* Per clip, not in total. Five pairs from each clip is enough to find the median of a distribution
   this tight, and keeps a ten-clip hero to about sixty ffmpeg calls - a couple of seconds. */
const SAMPLES = Number.isFinite(a.samples) && a.samples > 0 ? Math.floor(a.samples) : 5

/* Ratios, not SSIM values, because the whole point is that the raw number means nothing without the
   footage it came from. 0.85 and 0.60 are judgement calls and are printed as such: what earns its
   keep here is the RANKING, and the worst seam is worth looking at whatever bucket it lands in. */
const OK = 0.85
const CUT = 0.60

const clipDirs = fs.readdirSync(framesDir)
  .filter(d => /^clip\d+$/.test(d) && fs.statSync(path.join(framesDir, d)).isDirectory())
  .sort((x, y) => parseInt(x.slice(4), 10) - parseInt(y.slice(4), 10))

if (clipDirs.length < 2) {
  console.log(`seam check: ${clipDirs.length} clip(s) in ${framesDir} - a seam needs two, nothing to check.`)
  process.exit(0)
}

const framesOf = (dir) => fs.readdirSync(path.join(framesDir, dir))
  .filter(f => /^frame-\d+\.\w+$/.test(f))
  .sort()
  .map(f => path.join(framesDir, dir, f))

/* SSIM via ffmpeg's own filter, parsed off the "All:" field. Returns null rather than throwing on
   any failure: a check that cannot run must say so, not invent a score or take the build down. */
function ssim (fileA, fileB) {
  try {
    const out = execFileSync('ffmpeg',
      ['-v', 'error', '-i', fileA, '-i', fileB, '-lavfi', 'ssim=stats_file=-', '-f', 'null', '-'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const m = /All:([0-9.]+)/.exec(out)
    return m ? parseFloat(m[1]) : null
  } catch (_) { return null }
}

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((p, q) => p - q)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/* ---------- the baseline: what an ordinary step looks like in THIS footage ---------- */
const within = []
for (const dir of clipDirs) {
  const fr = framesOf(dir)
  if (fr.length < 2) continue
  /* Spread across the clip rather than taken from the front. The opening frames of a Kling segment
     move least - the model is still holding the first keyframe - so a sample taken from there
     reports a calmer baseline than the clip really has, and every seam then looks worse than it is. */
  const pairs = Math.min(SAMPLES, fr.length - 1)
  for (let i = 0; i < pairs; i++) {
    const at = Math.floor((i + 0.5) * (fr.length - 1) / pairs)
    const v = ssim(fr[at], fr[at + 1])
    if (v !== null) within.push(v)
  }
}
const baseline = median(within)

console.log(`\nseam check - ${clipDirs.length} clips, ${clipDirs.length - 1} joins`)
if (baseline === null) {
  console.error('\n  Could not measure anything. Is ffmpeg on PATH, and do the clip directories hold frames?')
  console.error('  node scripts/doctor.mjs checks ffmpeg.')
  process.exit(1)
}
console.log(`  baseline  ${baseline.toFixed(3)} SSIM  - median of ${within.length} ordinary frame-to-frame`)
console.log('            steps inside the clips, which is what this footage looks like WITHOUT a seam.\n')

/* ---------- the seams ---------- */
const rows = []
for (let i = 0; i < clipDirs.length - 1; i++) {
  const left = framesOf(clipDirs[i])
  const right = framesOf(clipDirs[i + 1])
  if (!left.length || !right.length) continue
  const v = ssim(left[left.length - 1], right[0])
  /* Guard the divide: a baseline of 0 would mean every sampled pair was identical, which happens
     on a frozen clip and would turn every ratio into Infinity or NaN. */
  const ratio = v === null || !baseline ? null : v / baseline
  rows.push({ from: clipDirs[i], to: clipDirs[i + 1], segment: i + 1, ssim: v, ratio })
}

const verdictOf = (r) => r.ratio === null ? 'not measured'
  : r.ratio >= OK ? 'ok'
    : r.ratio >= CUT ? 'worth a look'
      : 'LIKELY A VISIBLE CUT'

console.log('  join             SSIM    vs baseline   verdict')
for (const r of rows) {
  console.log(`  ${`${r.from} -> ${r.to}`.padEnd(17)}${r.ssim === null ? '  --  ' : r.ssim.toFixed(3)}` +
    `   ${r.ratio === null ? ' -- ' : r.ratio.toFixed(2) + 'x'}`.padEnd(14) + verdictOf(r))
}

const measured = rows.filter(r => r.ratio !== null)
const bad = measured.filter(r => r.ratio < CUT)
const soft = measured.filter(r => r.ratio >= CUT && r.ratio < OK)
const worst = measured.length ? measured.reduce((w, r) => (r.ratio < w.ratio ? r : w)) : null

console.log()
if (!measured.length) {
  console.log('  Nothing could be measured - check that ffmpeg is on PATH.')
} else if (!bad.length && !soft.length) {
  console.log(`  Every join is within ${OK.toFixed(2)}x of an ordinary step in this footage. Scroll it once to`)
  console.log('  confirm - this measures pixels, not composition, and a seam can match closely and still')
  console.log('  read wrong if the light or the framing shifted.')
} else {
  console.log(`  ${bad.length} likely cut(s), ${soft.length} worth a look. The weakest join is ` +
    `${worst.from} -> ${worst.to}.`)
  console.log('\n  That join is the tween BETWEEN two keyframes, so the segment to regenerate is the one')
  console.log(`  numbered for its first keyframe - here, segment ${worst.segment}:`)
  console.log(`    node "${path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), 'tween.mjs')}" --storyboard storyboard.json --only ${worst.segment}`)
  console.log('\n  Cheaper things to try first, in order: re-run that one segment (the model is not')
  console.log('  deterministic, so a second attempt often lands); then shorten it with --duration 3,')
  console.log('  which gives the model less room to invent; then reword that motion prompt in')
  console.log('  storyboard.json to describe one physical process rather than several.')
  console.log('  Then rebuild frames - build-frames.mjs costs nothing to re-run.')
}

/* Exit code is opt-in. The frames on disk are valid either way and the build that produced them
   already succeeded, so failing by default would turn a report into an obstacle. --strict is for
   the caller who wants this to gate. */
process.exitCode = a.strict && bad.length ? 1 : 0
