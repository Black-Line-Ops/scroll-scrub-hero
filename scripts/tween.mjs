/* Step 3: adjacent keyframe pairs -> Kling 3.0 first/last-frame segments.
   The expensive step. It confirms before spending, keeps per-segment state so a partial run
   resumes instead of re-paying, and re-uploads the keyframes first because the approval gate
   that precedes it routinely takes longer than kie.ai keeps an upload alive. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireKey, createTask, pollTask, download, freshUrl, state, args, confirm } from './kie.mjs'

/* Every command this script prints has to be runnable from the scratch directory the docs tell
   you to stay in, which is never the skill's scripts/ folder - so the script paths are absolute.
   fileURLToPath rather than import.meta.dirname, which only exists from Node 20.11 and this
   skill supports 18. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

const a = args()
if (!a.storyboard) {
  console.error(`usage: node "${path.join(HERE, 'tween.mjs')}" --storyboard storyboard.json [--keyframes keyframes/]\n` +
    '         [--out segments/] [--mode pro|std|4K] [--duration 5] [--aspect 16:9] [--only 3] [--yes]\n\n' +
    '  --yes   skip the confirmation prompt. Required when a script, CI or Claude runs this,\n' +
    '          because there is no keyboard attached to answer the prompt.')
  process.exit(1)
}
requireKey()

const sb = JSON.parse(fs.readFileSync(a.storyboard, 'utf8'))
const kfDir = path.resolve(a.keyframes || 'keyframes')
const outDir = path.resolve(a.out || 'segments')
const mode = a.mode || 'pro'
/* Number, not parseInt: parseInt('4.5') is 4, so a fractional value used to be rounded down in
   silence and then billed at a length nobody chose. The shared parser has already refused
   anything that is not a number, so all that is left here is the API's own enum. */
const duration = Number(a.duration ?? 5)
if (!Number.isInteger(duration) || duration < 3 || duration > 15) { console.error('--duration must be a whole number from 3 to 15 (the API accepts no other values)'); process.exit(1) }
const aspect = a.aspect || '16:9'

const kfStateFile = path.join(kfDir, '_state.json')
const kfState = state.load(kfStateFile)
if (!kfState.frames) {
  console.error(`no keyframes found in ${kfDir} - run keyframes.mjs first`)
  process.exit(1)
}

const stateFile = path.join(outDir, '_state.json')
const st = state.load(stateFile)
st.segments = st.segments || {}
fs.mkdirSync(outDir, { recursive: true })

/* A segment is identified everywhere - in state, in --only, in the retry hint printed at the end
   - by the step it starts FROM, so that number has to be unique before anything is billed. Two
   motions sharing a `from` would each create and pay for a Kling render, and the second would
   overwrite the first in state: one clip on disk for two paid videos. storyboard.mjs validates
   what Sol returns, but a hand-edited storyboard.json never passes through it. */
const motionIds = (sb.motions || []).map(m => m.from)
const dupes = [...new Set(motionIds.filter((id, i) => motionIds.indexOf(id) !== i))]
if (dupes.length) {
  console.error(`${a.storyboard} has more than one motion starting at step ${dupes.join(', ')}.`)
  console.error('Segment state is keyed by that number, so one render of each pair would be paid for and then discarded.')
  process.exit(1)
}

/* --only naming a segment the storyboard does not have used to filter the list down to nothing
   and then report "every segment already has a video on disk" at exit 0 - the opposite of the
   truth, at the one moment an operator is deciding whether the run is finished. A mistyped id is
   a stop, not a no-op. */
const only = a.only ? String(a.only).split(',').map(s => parseInt(s.trim(), 10)) : null
if (only) {
  const unknown = only.filter(id => !motionIds.includes(id))
  if (unknown.length) {
    console.error(`--only ${unknown.join(',')}: no such segment in ${a.storyboard}.`)
    console.error(`Segments are named by the step they start from: ${motionIds.join(', ') || '(this storyboard has no motions)'}`)
    process.exit(1)
  }
}
const motions = (sb.motions || []).filter(m => !only || only.includes(m.from))

/* A segment counts as done only if its file is actually on disk. Recording a taskId is not
   the same as having the video: a failed or timed-out segment used to stay in state forever
   and build-frames would then quietly ship a hero with a missing chapter. */
const isDone = (m) => {
  const s = st.segments[m.from]
  return !!(s && s.file && fs.existsSync(path.resolve(outDir, s.file)))
}
const todo = motions.filter(m => (only ? true : !isDone(m)))

if (!todo.length) { console.log('nothing to do - every segment already has a video on disk'); process.exit(0) }

const missing = []
for (const m of motions) {
  if (!kfState.frames[m.from]) missing.push(m.from)
  if (!kfState.frames[m.to]) missing.push(m.to)
}
if (missing.length) {
  console.error(`missing keyframes: ${[...new Set(missing)].join(', ')} - generate them first`)
  process.exit(1)
}

const res = mode === '4K' ? '3840x2160' : mode === 'std' ? '1280x720' : '1920x1080'

/* Kling renders at ~24fps (the repo's own test-footage recipe in examples/ generates at rate=24)
   and build-frames resamples every clip to exactly --per-clip frames no matter how many arrived,
   so each source frame past that count is rendered, paid for and thrown away. Stating the
   arithmetic is deliberately not a pricing claim - it is true whether kie.ai bills per second,
   in duration bands or per render, which is more than can be said for any saving estimate. */
const SRC_FPS = 24
const PER_CLIP = 40                      /* build-frames.mjs's --per-clip default; keep in step */
const srcFrames = duration * SRC_FPS + 1
const costLine =
  `\nAbout to generate ${todo.length} video segment(s)\n` +
  `  model     kling-3.0/video\n` +
  `  mode      ${mode} (${res} at ${aspect})\n` +
  `  duration  ${duration}s each  ->  ~${todo.length * duration}s of video total\n` +
  `  frames    ~${srcFrames} rendered per segment at ~${SRC_FPS}fps; build-frames keeps ${PER_CLIP} by default (--per-clip),\n` +
  `            so ~${srcFrames - PER_CLIP} frames per segment are paid for and thrown away\n` +
  (duration > 3
    ? `            --duration 3 still yields ~${3 * SRC_FPS + 1}, comfortably above ${PER_CLIP}\n`
    : '') +
  `  segments  ${todo.map(m => `${m.from}->${m.to}`).join(', ')}\n` +
  '\nVideo is the expensive part of this pipeline. Check current pricing for kling-3.0 on\n' +
  'kie.ai; this script does not know your rate and will not invent one. What it does record\n' +
  'is whatever kie.ai reports as creditsConsumed, per segment and alongside the duration it\n' +
  `was generated at, in\n  ${stateFile}\n` +
  'so the cost of a given --duration is something you can look up afterwards instead of estimate.'
console.log(costLine)

if (!await confirm('Proceed?', { yes: !!a.yes, whatItCosts: costLine })) {
  console.log('aborted - nothing generated, nothing charged')
  process.exit(1)
}

/* Which segments this process actually paid for, as opposed to which ones state has a figure
   for. They differ whenever a submit fails on a --only re-run: the old record, credits and all,
   is still sitting in state and must not be counted as spend that happened today. */
const generated = []

for (const m of todo) {
  /* Re-upload if the recorded URL is near kie.ai's 24h expiry. The approval gate before this
     step is meant to take as long as the human needs, so stale URLs are the normal case, and
     Kling given a dead URL fails in a way that looks like a model problem. */
  let first, last
  try {
    const f = await freshUrl(kfState.frames[m.from], kfState.frames[m.from]?.file)
    const l = await freshUrl(kfState.frames[m.to], kfState.frames[m.to]?.file)
    Object.assign(kfState.frames[m.from], f)
    Object.assign(kfState.frames[m.to], l)
    state.save(kfStateFile, kfState)
    first = f.url; last = l.url
  } catch (e) {
    console.error(`segment ${m.from}->${m.to}: could not prepare keyframes - ${e.message}`)
    continue
  }

  const prompt = String(m.prompt || '').slice(0, 500)   /* Kling caps single-shot prompts at 500 */
  console.log(`\nsegment ${m.from}->${m.to}: ${prompt.slice(0, 90)}${prompt.length > 90 ? '...' : ''}`)

  let taskId
  try {
    taskId = await createTask('kling-3.0/video', {
      prompt,
      /* [first frame, last frame]. Per the spec: length 2 = first and last; length 1 = first
         only. With images supplied, aspect_ratio is auto-adapted from them. */
      image_urls: [first, last],
      /* duration is a STRING enum ('3'..'15') in this API, not a number - sending 5 instead
         of "5" fails validation. */
      duration: String(duration),
      aspect_ratio: aspect,
      mode,
      sound: false,
      multi_shots: false,          /* the spec marks this required even for single-shot */
    })
  } catch (e) {
    console.error(`  FAILED to submit: ${e.message}`)
    continue
  }
  /* record the taskId immediately and separately from completion, so a crash here never
     loses the id (re-creating a running task bills twice) and never marks it done */
  st.segments[m.from] = { taskId, from: m.from, to: m.to, prompt, mode, duration, file: null }
  state.save(stateFile, st)

  const name = `segment-${String(m.from).padStart(2, '0')}.mp4`
  try {
    /* kie.ai reports creditsConsumed on the finished task (references/kie-api.md:46) and this
       pipeline used to discard it, which is why nobody here can say what a run costs and why the
       3s-vs-5s question is still an argument rather than a number. It arrives through a callback
       because pollTask resolves to the result URLs and its other callers index that array. */
    let meta = null
    const urls = await pollTask(taskId, {
      label: `seg${m.from}`,
      timeoutMs: 900000,
      onMeta: (info) => { meta = info },
    })
    /* Record the URL of the finished render BEFORE fetching it. By this point the render is paid
       for and the download is a free GET that can still fail; without the URL on disk the only
       way back to the video is to re-create the task, which bills a second time for a clip that
       already exists. Same reasoning as recording the taskId above, one step later. */
    st.segments[m.from].resultUrl = urls[0]
    const credits = Number(meta?.creditsConsumed)
    if (Number.isFinite(credits)) st.segments[m.from].creditsConsumed = credits
    state.save(stateFile, st)
    generated.push(m.from)

    await download(urls[0], path.join(outDir, name))
    /* store the BASENAME. A CWD-relative path here breaks build-frames the moment it runs
       from a different directory, which the docs actively encourage. */
    st.segments[m.from].file = name
    delete st.segments[m.from].error
    state.save(stateFile, st)
    console.log(`  -> ${path.join(outDir, name)}`)
  } catch (e) {
    st.segments[m.from].error = String(e.message || e)
    state.save(stateFile, st)
    console.error(`  FAILED: ${e.message}`)
    console.error(`  taskId ${taskId} is saved in ${stateFile} - query it before regenerating, or you pay twice`)
    /* If the render finished and only the download blipped, the paid clip is still sitting at a
       URL we now have on record. Say so here, because the obvious next move - re-run tween.mjs -
       would re-create the task and pay for the same video again. */
    if (st.segments[m.from].resultUrl) {
      console.error('  the video itself is already rendered and paid for; fetch it by hand instead of re-running:')
      console.error(`    ${st.segments[m.from].resultUrl}`)
      console.error(`    save it as ${path.join(outDir, name)}, then set "file": "${name}" on segment ${m.from} in`)
      console.error(`    ${stateFile}, or the next run counts it missing and pays for it again.`)
      console.error('    Do it now - kie.ai does not host results indefinitely.')
    }
  }
}

const total = (sb.motions || []).length
const done = (sb.motions || []).filter(isDone).length
console.log(`\n${done}/${total} segments have a video on disk in ${outDir}`)

/* What the run actually cost, read back out of the state file rather than from a running tally,
   so the number printed here and the number a later run quotes cannot drift apart. This prints
   before the incomplete-run exit below on purpose: a run that half-failed still spent money, and
   that is the case where the operator most needs to know how much. */
const creditsOf = (id) => {
  const c = st.segments[id]?.creditsConsumed
  return Number.isFinite(c) ? c : null
}
const sum = (ids) => ids.reduce((n, id) => n + creditsOf(id), 0)
const billed = generated.filter(id => creditsOf(id) !== null)
if (billed.length) {
  const runTotal = sum(billed)
  console.log(`credits this run: ${runTotal} for ${billed.length} segment(s) at ${duration}s ` +
    `(${(runTotal / billed.length).toFixed(1)} per segment)`)
  /* The per-storyboard figure is the one that answers "is 3s cheaper than 5s" - a single run is
     usually a partial one. Only worth a line when it says something the run total did not. */
  const recorded = Object.keys(st.segments).filter(id => creditsOf(id) !== null)
  if (recorded.length > billed.length) {
    console.log(`credits recorded for all ${recorded.length} segment(s) in this storyboard: ${sum(recorded)}`)
  }
  console.log(`kie.ai/logs is the source of truth if a bill looks wrong; per-segment figures are in ${stateFile}`)
} else if (generated.length) {
  console.log('credits: kie.ai reported no creditsConsumed for these segments, so this run is unmeasured')
}

if (done < total) {
  const bad = (sb.motions || []).filter(m => !isDone(m)).map(m => m.from)
  console.log(`incomplete: segment(s) ${bad.join(', ')} - re-run with --only ${bad.join(',')}`)
  console.log('Do NOT run build-frames yet: it would build a hero with those chapters missing.')
  process.exit(1)
}
/* The script path is absolute for the same reason its two arguments already were: this line is
   read from the scratch directory the docs prescribe, where there is no scripts/ folder, and a
   bare `node build-frames.mjs` there fails with ERR_MODULE_NOT_FOUND. */
console.log(`next: node "${path.join(HERE, 'build-frames.mjs')}" --segments "${outDir}" --storyboard "${path.resolve(a.storyboard)}" --out <site>/assets/hero-scroll/frames/`)
