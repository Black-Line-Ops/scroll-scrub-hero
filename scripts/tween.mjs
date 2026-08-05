/* Step 3: adjacent keyframe pairs -> Kling 3.0 first/last-frame segments.
   The expensive step. It confirms before spending, keeps per-segment state so a partial run
   resumes instead of re-paying, and re-uploads the keyframes first because the approval gate
   that precedes it routinely takes longer than kie.ai keeps an upload alive. */
import fs from 'node:fs'
import path from 'node:path'
import { requireKey, createTask, pollTask, download, freshUrl, state, args, confirm } from './kie.mjs'

const a = args()
if (!a.storyboard) {
  console.error('usage: node tween.mjs --storyboard storyboard.json [--keyframes keyframes/] [--out segments/]\n' +
    '                    [--mode pro|std|4K] [--duration 5] [--aspect 16:9] [--only 3] [--yes]\n\n' +
    '  --yes   skip the confirmation prompt. Required when a script, CI or Claude runs this,\n' +
    '          because there is no keyboard attached to answer the prompt.')
  process.exit(1)
}
requireKey()

const sb = JSON.parse(fs.readFileSync(a.storyboard, 'utf8'))
const kfDir = path.resolve(a.keyframes || 'keyframes')
const outDir = path.resolve(a.out || 'segments')
const mode = a.mode || 'pro'
const duration = parseInt(a.duration || '5', 10)
if (!(duration >= 3 && duration <= 15)) { console.error('--duration must be a whole number from 3 to 15 (the API accepts no other values)'); process.exit(1) }
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

const only = a.only ? String(a.only).split(',').map(s => parseInt(s.trim(), 10)) : null
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
const costLine =
  `\nAbout to generate ${todo.length} video segment(s)\n` +
  `  model     kling-3.0/video\n` +
  `  mode      ${mode} (${res} at ${aspect})\n` +
  `  duration  ${duration}s each  ->  ~${todo.length * duration}s of video total\n` +
  `  segments  ${todo.map(m => `${m.from}->${m.to}`).join(', ')}\n` +
  '\nVideo is the expensive part of this pipeline. Check current per-second pricing for\n' +
  'kling-3.0 on kie.ai; this script does not know your rate and will not invent one.'
console.log(costLine)

if (!await confirm('Proceed?', { yes: !!a.yes, whatItCosts: costLine })) {
  console.log('aborted - nothing generated, nothing charged')
  process.exit(1)
}

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

  try {
    const urls = await pollTask(taskId, { label: `seg${m.from}`, timeoutMs: 900000 })
    const name = `segment-${String(m.from).padStart(2, '0')}.mp4`
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
  }
}

const total = (sb.motions || []).length
const done = (sb.motions || []).filter(isDone).length
console.log(`\n${done}/${total} segments have a video on disk in ${outDir}`)
if (done < total) {
  const bad = (sb.motions || []).filter(m => !isDone(m)).map(m => m.from)
  console.log(`incomplete: segment(s) ${bad.join(', ')} - re-run with --only ${bad.join(',')}`)
  console.log('Do NOT run build-frames yet: it would build a hero with those chapters missing.')
  process.exit(1)
}
console.log(`next: node build-frames.mjs --segments "${outDir}" --storyboard "${path.resolve(a.storyboard)}" --out <site>/assets/hero-scroll/frames/`)
