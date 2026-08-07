/* Step 4: segment videos -> the numbered WebP frames the page scrubs, plus config.js.
   This is the step that decides page weight, so it measures and reports rather than leaving
   you to discover a 60 MB hero after deploying it. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { state, args } from './kie.mjs'

/* --allow-gaps carries no value, so the shared parser has to be told about it. An undeclared
   value-less flag at the end of argv is rejected as "--allow-gaps needs a value". */
const a = args(process.argv.slice(2), { booleans: ['allow-gaps'] })
if (!a.segments || !a.storyboard || !a.out) {
  console.error('usage: node build-frames.mjs --segments segments/ --storyboard storyboard.json --out <site>/assets/hero-scroll/frames/\n' +
    '                          [--width 1600] [--per-clip 40] [--quality 78] [--budget-mb 35] [--var HERO] [--allow-gaps]\n\n' +
    '  --allow-gaps  build from whatever clips exist instead of stopping when the storyboard\n' +
    '                describes segments that have no video. For the bring-your-own-clips path.')
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

/* This value is interpolated straight into generated JavaScript source (window.<prefix>_SEQ), so
   it has to BE an identifier. The shared parser checks --var as well, but the check belongs next
   to the sink: a default, a config read or a direct call never passes through the parser.
   The realistic mistake here is not an attack, it is `--var hero-scroll` - a very plausible
   choice given the output folder is named hero-scroll - which emits `window.hero-scroll_SEQ=[`,
   throws at load time on the live page, and lets this script print its full success summary and
   exit 0 with a dead hero. */
if (!/^[A-Za-z_$][\w$]*$/.test(prefix)) {
  console.error(`--var must be a JavaScript identifier (letters, digits, _ and $, not starting with a digit); got "${prefix}"`)
  process.exit(1)
}

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
/* stdio is piped, so ffmpeg's own explanation of a failure lands on e.stderr where nothing
   printed it: an unknown encoder used to surface as an unhandled `Command failed`, a raw Buffer
   dump and a stack trace, at the end of a run that had already paid for both generation steps.
   Every call site below catches and reports, so these two only have to make the cause legible. */
const ffErr = (e) => String(e.stderr || e.message || '').trim()
const indent = (s) => s.split('\n').map(l => '     ' + l).join('\n')
/* `| grep` is not a command in cmd.exe or PowerShell, and Windows is a first-class target here
   (doctor.mjs installs ffmpeg with winget). A remedy the reader cannot run is worse than none. */
const encoderCheck = () => os.platform() === 'win32'
  ? '     Check:  ffmpeg -hide_banner -encoders | findstr /i webp'
  : '     Check:  ffmpeg -hide_banner -encoders | grep -i webp'

/* The clip directory the loop below is halfway through filling, or null between clips. Every
   failure inside that loop leaves that directory holding fewer frames than any config describes,
   so it is removed on the way out: a chapter that is simply absent is unambiguous in a way that
   a chapter holding part of its frames is not, and the operator re-running after a re-download
   should not be diffing against leftovers from the attempt that failed. */
let building = null
const abort = () => {
  if (building) fs.rmSync(building, { recursive: true, force: true })
  process.exit(1)
}

/* The caption lookup at the bottom of the clip loop indexes sb.steps, and nothing checked that the
   key is there. Measured with a storyboard carrying motions but no steps: this script cut clip1's
   frames in full, then died inside the loop on `sb.steps.find` with a raw
   `TypeError: Cannot read properties of undefined (reading 'find')` and a stack trace naming
   neither the storyboard nor the problem - and because that is a throw rather than abort(), the
   clip directory it was holding was left on disk for the next run to diff against. Every clip
   before the crash is ffmpeg time already spent on a storyboard that could never have finished,
   so the refusal belongs up here, above the loop, where it costs nothing. It goes through abort()
   so the half-built-directory cleanup stays wired to every exit path in this file.
   keyframes.mjs:39-42 turns the same storyboard away for the same reason. */
if (!Array.isArray(sb.steps) || !sb.steps.length) {
  console.error(`${a.storyboard} has no steps, so no clip can be captioned (steps must be a non-empty array).`)
  abort()
}

const probe = (f) => {
  try {
    /* stdio matches ff() above: execFileSync otherwise echoes the child's stderr to ours AND
       captures it, so a failure printed its explanation twice, once unlabelled. */
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration:stream=width,height,nb_frames', '-of', 'json', f],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  } catch (e) {
    console.error(`\n  !! ffprobe could not read ${path.basename(f)}.`)
    console.error(indent(ffErr(e)))
    abort()
  }
}

/* Resolve each recorded file against the segments directory. Older state files stored a
   CWD-relative path, so fall back to the raw value for backward compatibility. */
const segDir = path.resolve(a.segments)
const segments = []
const lost = []
for (const s of Object.values(segState.segments || {})) {
  const cands = [s.file && path.resolve(segDir, path.basename(s.file)), s.file && path.resolve(s.file)].filter(Boolean)
  const found = cands.find(p => fs.existsSync(p)) || null
  if (found) segments.push({ ...s, file: found })
  else lost.push(s)
}
segments.sort((x, y) => x.from - y.from)

/* A segment whose mp4 was moved or deleted after tween recorded it used to be filtered out here
   without a word, and the hero shipped one chapter short. Say it out loud; whether it is fatal is
   the storyboard cross-check's decision, a few lines down. */
for (const s of lost) {
  console.log(`  !! segment ${s.from}->${s.to} is recorded as generated but ` +
    `${s.file ? `${path.basename(s.file)} is not in ${a.segments}` : 'no file was ever written'}`)
}

if (!segments.length) { console.error(`no completed segments in ${a.segments}`); process.exit(1) }

/* The clip number used to come from the loop counter while the caption came from the segment's
   own `to` step, so one missing segment slid every later caption one chapter out of place and
   the run still exited 0 - a paid, visibly wrong deliverable with every signal reading success.
   sb.motions is the only record of how many segments SHOULD exist and nothing here consulted it.
   Both halves close together below: a motion with no video is an error rather than a silent
   renumbering, and the chapter index is the motion's own index, so the folder name and the
   caption can no longer drift apart. */
const motions = Array.isArray(sb.motions) ? sb.motions : []
if (motions.length) {
  const missing = motions.filter(m => !segments.some(s => s.from === m.from))
  if (missing.length) {
    console.error(`\n  !! ${missing.length} of ${motions.length} segment(s) described by ${a.storyboard} have no video:`)
    console.error(`     ${missing.map(m => `${m.from}->${m.to}`).join(', ')}`)
    if (!a['allow-gaps']) {
      console.error('     Building now would ship a hero with those chapters missing, at exit 0.')
      console.error(`     Generate them:  node tween.mjs --storyboard "${a.storyboard}" --only ${missing.map(m => m.from).join(',')}`)
      console.error('     Or pass --allow-gaps if this storyboard is not meant to describe these clips.')
      process.exit(1)
    }
    /* same stream as the four lines above it - a block split across stdout and stderr
       interleaves out of order the moment either one is piped or redirected */
    console.error('     --allow-gaps was given, so building without them. The hero will have a hole here.')
  }
  for (const stray of segments.filter(s => !motions.some(m => m.from === s.from))) {
    console.log(`  !! segment ${stray.from}->${stray.to} is not in the storyboard; it is numbered after the storyboard's own chapters`)
  }
} else if (!a['allow-gaps']) {
  /* No motions at all means the storyboard cannot vouch for anything, including the captions
     this script is about to read out of it. Numbering falls back to position - say so. */
  console.log(`  !! ${a.storyboard} lists no motions, so nothing can be cross-checked; clips are numbered in order`)
}

/* Number every clip once, up front, and use that one number for the folder AND the caption.
   A segment the storyboard describes takes its motion's index, so a gap leaves a hole rather
   than sliding every later chapter's caption one place; a segment it has never heard of is
   numbered above the storyboard's range, where it cannot land on another clip's folder and
   overwrite it. With no motions to key against, this is plain 1..N in order. */
const chapters = new Map()
let spare = motions.length + 1
for (const seg of segments) {
  const mi = motions.findIndex(m => m.from === seg.from)
  chapters.set(seg, mi === -1 ? spare++ : mi + 1)
}

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

/* config.js is the only index this tree has: the page reads it and fetches exactly the frames it
   names. Every guard below stops the run rather than ship something wrong - but stopping is only
   half an answer, because the loop rebuilds each clip directory by DELETING it first, so a run
   that dies partway has already changed the frames the LAST run's config describes. Measured, two
   runs over the same tree: a healthy pair of 5s segments wrote clip1 n:40 and clip2 n:40; re-run
   with seg-02.mp4 truncated to 22% of its bytes, clip1 was rebuilt to 40 and clip2 emptied and
   refilled with 9 before the shortfall guard exited 1 - and the first run's config.js was still
   sitting there claiming clip2 held 40. An already-wired page 404s frames 10-40.

   So the config is removed before the first directory is touched and rewritten only once every
   clip is cut, which establishes: every clip config.js names is on disk with the frame count it
   claims. A failed run now leaves no config rather than a lying one. (The converse is not
   claimed - a clip directory left by an earlier, longer build is dead weight nothing fetches,
   which is a wasted deploy, not a broken scrub.) Re-run the two-run sequence above to check it. */
const cfgFile = path.join(outDir, 'config.js')
fs.rmSync(cfgFile, { force: true })

const seq = []
let totalBytes = 0

for (const seg of segments) {
  const chapter = chapters.get(seg)
  const dir = path.join(outDir, `clip${chapter}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  building = dir

  /* ffprobe prints the STRING "N/A" for a container that carries no duration, and "N/A" is
     truthy, so the `seg.duration` fallback written for exactly this case never ran: dur was NaN,
     fps was the string "NaN", and ffmpeg's rejection of `-vf fps=NaN` arrived with its stderr
     swallowed. Take the probe, then what tween recorded, then stop - guessing a duration for a
     file whose real one is unknown just samples the wrong part of it. */
  const meta = probe(seg.file)
  const probed = parseFloat(meta.format?.duration)
  const recorded = Number(seg.duration)
  const dur = Number.isFinite(probed) && probed > 0 ? probed
    : Number.isFinite(recorded) && recorded > 0 ? recorded : NaN
  if (!Number.isFinite(dur)) {
    console.error(`\n  !! ${path.basename(seg.file)} reports no usable duration ` +
      `(ffprobe said ${JSON.stringify(meta.format?.duration ?? null)}, state says ${JSON.stringify(seg.duration ?? null)}).`)
    console.error('     The file is probably truncated or was only partly downloaded. Re-download the')
    console.error('     segment and re-run - nothing new is billed for a download.')
    abort()
  }
  /* Sample an even spread rather than taking the first N frames, so the clip covers the whole
     motion. fps = frames wanted / seconds available. */
  const fps = (perClip / dur).toFixed(6)

  console.log(`clip${chapter}  <- ${path.basename(seg.file)}  ${dur.toFixed(2)}s -> ${perClip} frames @ ${width}px`)
  try {
    ff(['-i', seg.file,
      '-vf', `fps=${fps},scale=${width}:-2:flags=lanczos`,
      '-vsync', '0',
      '-c:v', 'libwebp', '-quality', String(quality), '-preset', 'picture',
      path.join(dir, 'frame-%04d.webp')])
  } catch (e) {
    /* Without this the missing-libwebp case - the first cause named by the zero-frame guard
       below - could never reach that guard: ffmpeg exits non-zero, execFileSync throws, and the
       diagnostic written for this exact scenario was skipped in favour of a stack trace. */
    const err = ffErr(e)
    console.error(`\n  !! ffmpeg failed while cutting clip${chapter} from ${path.basename(seg.file)}.`)
    /* Match what ffmpeg says about the encoder, not the word "libwebp" - a build that HAS the
       encoder still prints `[libwebp @ ...]` in front of an unrelated complaint, and telling
       someone their ffmpeg is missing a feature it has sends them off to reinstall for nothing. */
    if (/unknown encoder|encoder not found/i.test(err)) {
      console.error('     This ffmpeg has no libwebp encoder, so it cannot write WebP frames.')
      console.error(encoderCheck())
    }
    console.error(indent(err))
    abort()
  }

  let files = fs.readdirSync(dir).filter(f => f.endsWith('.webp')).sort()
  /* fps sampling can land one over or under; normalise so config.js and disk agree exactly,
     because the page indexes frames by number and a missing file is a broken scrub.

     Dropping the TRAILING frame is deliberate, and it is the frame to drop. The sampler stops
     one step short of the end, so a 41st frame only ever appears at t=duration - which is the
     destination keyframe, byte-identical to the next clip's frame 1. Keeping it would hold the
     seam for one frame, the very stall that dropping it avoids. Do not "fix" this. */
  while (files.length > perClip) {
    fs.rmSync(path.join(dir, files.pop()))
  }

  /* Zero frames means ffmpeg produced nothing - a corrupt download, or a build without
     libwebp. Writing n:0 into config and exiting 0 would ship a hero with a dead chapter
     and no error anywhere, so stop here instead. */
  if (!files.length) {
    console.error(`\n  !! clip${chapter} produced no frames from ${path.basename(seg.file)}.`)
    console.error('     Usually the segment is corrupt, or this ffmpeg has no libwebp encoder.')
    console.error(encoderCheck())
    abort()
  }

  /* A shortfall is not a rounding artefact once it is large: it means the container advertised
     more video than it holds, i.e. a truncated or partly-downloaded segment. The pad loop below
     would top it up by repeating the last frame however many times it takes, so a clip with 16
     real frames still reported a clean 40 and froze that chapter for 62% of its scroll, at
     exit 0. Past a tenth of the clip that is a broken deliverable, not a normalisation. */
  const minFrames = Math.ceil(perClip * 0.9)
  if (files.length < minFrames) {
    console.error(`\n  !! clip${chapter} produced only ${files.length} of ${perClip} frames from a ${dur.toFixed(2)}s segment.`)
    console.error(`     ${path.basename(seg.file)} is probably truncated - check it plays all the way through.`)
    console.error(`     Filling the gap would freeze this chapter for ${Math.round(100 - files.length / perClip * 100)}% of its scroll,`)
    console.error('     so stop here. Re-download the segment, or lower --per-clip to what the footage supports.')
    abort()
  }
  if (files.length < perClip) {
    console.log(`         !! only ${files.length} of ${perClip} frames; repeating the last one ${perClip - files.length}× to fill the clip`)
  }
  while (files.length < perClip) {
    const src = path.join(dir, files[files.length - 1])
    const dst = path.join(dir, `frame-${String(files.length + 1).padStart(4, '0')}.webp`)
    fs.copyFileSync(src, dst)
    files.push(path.basename(dst))
  }

  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0)
  totalBytes += bytes
  const dest = sb.steps.find(s => s.id === seg.to) || {}
  seq.push({
    dir: `clip${chapter}`,
    n: files.length,
    k: `${String(chapter).padStart(2, '0')} · ${dest.label || 'Step ' + chapter}`,
    t: dest.caption || '',
  })
  console.log(`         ${files.length} frames, ${(bytes / 1048576).toFixed(1)} MB ` +
    `(${Math.round(bytes / files.length / 1024)} KB/frame)`)
  building = null
}

const cfg = `window.${prefix}_EXT="webp";\nwindow.${prefix}_SEQ=[\n` +
  seq.map(s => '  ' + JSON.stringify(s) + ',').join('\n') +
  '\n];\n'
/* Write-then-rename, the same shape state.save() uses in kie.mjs. config.js is never the file
   being written into, so the name the page loads is only ever taken over by a config that is
   already whole - worth the two extra lines here because this one is generated JavaScript, and a
   half-written one throws at load time rather than merely 404ing a frame. */
const cfgTmp = cfgFile + '.tmp'
fs.writeFileSync(cfgTmp, cfg)
fs.renameSync(cfgTmp, cfgFile)

const mb = totalBytes / 1048576
console.log(`\nwrote ${seq.length} clips, ${seq.reduce((n, s) => n + s.n, 0)} frames, ${mb.toFixed(1)} MB total`)
console.log(`config: ${cfgFile}`)

if (mb > budgetMb) {
  console.log(`\n  !! ${mb.toFixed(1)} MB is over the ${budgetMb} MB budget.`)
  console.log('     Every frame is fetched and decoded by the browser, so this is felt on first load.')
  console.log(`     Try --per-clip ${Math.max(24, Math.floor(perClip * budgetMb / mb))} or --width ${Math.round(width * 0.8)} or --quality ${Math.max(60, quality - 10)}.`)
} else {
  console.log(`within the ${budgetMb} MB budget.`)
}
console.log('\nIf the page already reads this config, reload and scrub it. Otherwise see references/hero-wiring.md.')
