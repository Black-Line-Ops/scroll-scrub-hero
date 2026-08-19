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
    '         [--out segments/] [--mode pro|std|4K] [--duration 5] [--aspect 16:9] [--only 3] [--yes]\n' +
    '         [--dry-run]  print every motion prompt and the cost, generate nothing\n\n' +
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

/* The rate table, the estimate and the balance all come from pricing.mjs, and it is imported
   DYNAMICALLY and non-fatally on purpose. test/helpers/harness.mjs copies this file ON ITS OWN
   into a sandbox next to a generated stub kie.mjs, and a sibling module does not exist there: a
   static import would stop the script loading at all, in the one place that proves the gate works.
   A gate that cannot price is a nuisance. A gate that cannot start is a broken pipeline. The
   fallback below says so out loud rather than quietly dropping the cost line. */
let pricing = null
let pricingProblem = ''
try {
  pricing = await import('./pricing.mjs')
} catch (e) {
  pricingProblem = e && e.code === 'ERR_MODULE_NOT_FOUND'
    ? 'pricing.mjs is not next to this script'
    : `pricing.mjs did not load (${(e && e.message) || e})`
}

const rates = pricing ? pricing.loadRates() : null
const est = pricing ? pricing.estimateTween({ segments: todo.length, seconds: duration, mode, rates }) : null
/* est.known is false for an unrecognised --mode, and then there is no row to quote provenance
   from; every other path that reaches here has one. */
const rateRow = est && est.known ? rates.entries[`video.${mode}`] : null

/* fetchBalance is deliberately NOT handed requireKey()'s return value. It reads KIE_API_KEY
   itself, and the test harness's stub requireKey() answers with a fake key while the real
   variable is stripped from the child's environment - passing it through would turn an offline
   test into a live request to kie.ai. Reading the env keeps "no key, no request" true in both
   worlds. One attempt, 8s deadline, never throws: a spend gate is allowed to run without knowing
   the balance, and must never hang waiting for it. */
const balance = pricing ? await pricing.fetchBalance({ rates }) : null

/* Kling renders at ~24fps (the repo's own test-footage recipe in examples/ generates at rate=24)
   and build-frames resamples every clip to exactly --per-clip frames no matter how many arrived,
   so each source frame past that count is rendered, paid for and thrown away. Stating the
   arithmetic is deliberately not a pricing claim - it is true whether kie.ai bills per second,
   in duration bands or per render, which is more than can be said for any saving estimate. */
const SRC_FPS = 24
const PER_CLIP = 40                      /* build-frames.mjs's --per-clip default; keep in step */
const srcFrames = duration * SRC_FPS + 1

/* The money lines. Everything a person needs to answer y/n, in the order they need it: what it
   should cost, how that number was arrived at, who says so, and whether the account can cover it.
   formatCost is pricing.mjs's only renderer for a cost figure, so this reads the same here as it
   does everywhere else that quotes one. */
const costLines = []
if (est && est.known) {
  costLines.push(`  cost      ${pricing.formatCost(est)}   <- an ESTIMATE, not a quote`)
  costLines.push(`            ${est.basis}`)
  costLines.push(`            confidence ${est.confidence}, checked ${rateRow.checked}`)
  costLines.push(`            source ${rateRow.source}`)
} else if (est) {
  costLines.push(`  cost      ${pricing.formatCost(est)}`)
} else {
  costLines.push(`  cost      not estimated - ${pricingProblem}`)
}
if (balance) costLines.push(`  account   ${pricing.formatBalance(balance, est)}`)

/* The one thing this gate can tell you that nothing else will: the run does not fit. Checked
   against the HIGH end and only when both figures are real - est.known and est.partial exist
   precisely so a floor is never mistaken for a total. */
const shortOfCredit = !!(balance && balance.known && est && est.known && !est.partial &&
  est.credits && balance.credits < est.credits.high)

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
  costLines.join('\n') + '\n' +
  (shortOfCredit
    ? '\n!! NOT ENOUGH CREDIT for this run, per the account line above. Kling is billed segment\n' +
      '   by segment as the run proceeds, so starting anyway buys some clips and no finished\n' +
      '   hero. Top up first, or cut this run down with --only.\n'
    : '') +
  '\nVideo is the expensive part of this pipeline. ' +
  /* The two halves of this paragraph have to disagree, because in one case there is an estimate
     above and in the other there is not. A tail that pointed at a rate table the script has just
     said it could not load would be the same defect this repo was audited for: prose asserting
     something the code did not do. */
  (pricing
    ? 'The cost above is an estimate from the rate table in\n' +
      'pricing.mjs, which names the page every rate was read off and how to pin your own:\n' +
      `  node "${path.join(HERE, 'pricing.mjs')}"\n`
    : 'Without pricing.mjs this script does not know your\n' +
      'rate and will not invent one; kie.ai publishes current kling-3.0 pricing.\n') +
  'What gets RECORDED either way is whatever kie.ai reports as creditsConsumed, per segment and\n' +
  `alongside the duration it was generated at, in\n  ${stateFile}\n` +
  (pricing
    ? 'and this run compares that against the estimate when it finishes, so the cost of a given\n' +
      '--duration ends up measured rather than argued about.'
    : 'so the cost of a given --duration is something you can look up afterwards instead of guess.')
console.log(costLine)

/* Ahead of the confirm and ahead of --yes, for the reason keyframes.mjs puts it there. This is
   the expensive stage - video is roughly four fifths of a run - so it is also the one where
   reading the prompts first is worth the most. */
if (a['dry-run']) {
  console.log('\n--dry-run: the motion prompts that would be sent, in order\n')
  for (const m of todo) {
    console.log(`  segment ${m.from} -> ${m.to}`)
    console.log(String(m.prompt || '(no prompt)').split('\n').map(l => '      ' + l).join('\n'))
    console.log('')
  }
  console.log('Nothing was generated and nothing was charged. Drop --dry-run to run it.')
  process.exit(0)
}
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

/* creditsConsumed is a MEASUREMENT, and formatCost renders Estimates - it would dress this in a
   "~" and a range it does not have. So the conversion happens here, through the same creditUsd
   row the estimate used, which is why pinning creditUsd moves the prediction and the bill
   together. The dollars are an upper bound either way: kie.ai's bonus top-up SKUs can make a
   credit cost up to ~10% less, and the table's own note says so. */
const usdOf = (credits) => {
  const cu = rates && rates.entries.creditUsd
  return cu ? ` (~$${(credits * cu.low).toFixed(2)})` : ''
}

const billed = generated.filter(id => creditsOf(id) !== null)
if (billed.length) {
  const runTotal = sum(billed)
  console.log(`credits this run: ${runTotal}${usdOf(runTotal)} for ${billed.length} segment(s) at ${duration}s ` +
    `(${(runTotal / billed.length).toFixed(1)} per segment)`)
  /* The per-storyboard figure is the one that answers "is 3s cheaper than 5s" - a single run is
     usually a partial one. Only worth a line when it says something the run total did not. */
  const recorded = Object.keys(st.segments).filter(id => creditsOf(id) !== null)
  if (recorded.length > billed.length) {
    const all = sum(recorded)
    console.log(`credits recorded for all ${recorded.length} segment(s) in this storyboard: ${all}${usdOf(all)}`)
  }
  /* Estimate versus bill. Measured against an estimate for the segments actually BILLED, not the
     ones ordered: a run where two of four submits failed would otherwise compare four segments'
     prediction with two segments' bill and announce that the rate table is 50% high. That is the
     exact failure mode this whole exercise exists to avoid - a confident wrong number. */
  if (est && est.known) {
    const obs = pricing.observedFromSegments(st.segments, { only: billed })
    const billedEst = pricing.estimateTween({ segments: billed.length, seconds: duration, mode, rates })
    for (const line of pricing.formatCalibration(pricing.calibrate(billedEst, obs, { rates }))) {
      console.log(line)
    }
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
