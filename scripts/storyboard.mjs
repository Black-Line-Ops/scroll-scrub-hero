/* Step 1: reference photo + idea -> storyboard.json
   Sol is multimodal, so it can actually look at the property and write steps that reference
   what is there. That is the whole reason for using it rather than writing prompts blind.

   --ref is optional. Without it the script SEEDS: Sol writes a photographic description of the
   starting state from --idea alone, GPT Image 2 renders that as keyframe 1's source, and the
   normal chain runs from there. Everything downstream is unchanged, because the seed is written
   to disk and named in _meta.ref exactly as a supplied photo would be. */
import fs from 'node:fs'
import path from 'node:path'
import { requireKey, uploadFile, createTask, pollTask, download, sol, args } from './kie.mjs'

const a = args()
/* Type-check, not truth-check. `a` is produced by the parser, so a guard that trusts the parser
   cannot catch the parser being wrong - and it once was: `--idea --steps 6` bound the boolean true
   to idea, `!true` is false, this guard waved it through, and kie.ai was paid to storyboard the
   literal string "Idea: true". kie.mjs rejects that argv now, but the two ends stay independent on
   purpose. A validation guard that only works when its input is already correct is not a guard.

   --ref keeps its type check but loses its presence check: absent is now a MODE, `--ref` with no
   value is still a mistake. kie.mjs's parser already exits on the second ("--ref needs a value"),
   so on today's code this branch is unreachable - kept anyway, for the reason above and because of
   what it is standing in front of. Everywhere else a parser slip costs a bad request; here it
   would fall through to the seed path and spend an image credit drawing a house for somebody who
   already owns one and merely mistyped its path. */
if ('ref' in a && typeof a.ref !== 'string') {
  console.error('--ref needs a file path. Leave the flag off entirely to generate the first frame from --idea.')
  process.exit(1)
}
if (typeof a.idea !== 'string' || !a.idea.trim()) {
  console.error('usage: node storyboard.mjs --idea "<idea>" [--ref <photo>] [--steps 6] [--ref2 <after-photo>] [--out storyboard.json]')
  console.error('       with --ref     the photo is keyframe 1')
  console.error('       without --ref  keyframe 1 is generated from the idea: [--aspect 16:9] [--resolution 2K]')
  console.error('       forecast-only, changes nothing here: [--mode pro|std|4K] [--duration 5]')
  console.error('       [--style "<art direction>"]  one line of look-and-feel, applied to every frame')
  console.error('       [--captions sol|mine|none]  who writes the on-page text (default sol)')
  console.error('       [--float] [--float-color "#FF00FF"]  render on a flat field so build-frames can key it out')
  console.error('       [--dry-run]  print the plan and the whole bill, send nothing, charge nothing')
  process.exit(1)
}
/* A photo that is not there is worth catching now rather than after Sol has been billed - and
   before the seed branch, so a typo'd path fails as a typo instead of quietly generating a house. */
if (typeof a.ref === 'string' && !fs.existsSync(a.ref)) {
  console.error(`reference photo not found: ${a.ref}`)
  process.exit(1)
}
const seeding = typeof a.ref !== 'string'
/* One line of art direction, not a paragraph. It is appended to prompts that already carry a
   camera line, an anchor clause and a continuity clause, and a long style block starts winning
   arguments against the parts that keep consecutive frames looking like the same place - which is
   the one failure this pipeline cannot recover from without paying again. Trimmed to '' rather
   than left undefined, because every consumer tests it for truthiness and the string "undefined"
   is famously truthy.

   It matters most on a seeded run. With a photo, the photo is the art direction; with nothing, the
   image model falls back to whatever it likes this week, and two runs of the same idea come back
   looking like different companies. */
const style = typeof a.style === 'string' ? a.style.trim() : ''

/* ---------- who writes the words that go on the page ----------

   Every stage carries a kicker and a caption, and they end up in config.js as `k` and `t` - on the
   client's site, next to their logo, as marketing copy. Until now Sol wrote them and nobody chose
   that. It was simply what happened, and the first time anyone saw the words was in storyboard.json
   after the call had been paid for.

   For an agency that is the wrong default to have no alternative to: a model writing customer-facing
   copy unreviewed is a different kind of risk from a model drawing a fence in the wrong place.

     sol    what has always happened. Sol writes both, you edit storyboard.json if you disagree.
     mine   Sol writes the LABELS - the contact sheet needs them to identify frames, and they are
            internal - but every caption comes back as a marker that is impossible to mistake for
            copy. build-frames.mjs refuses to build a page out of them.
     none   no text at all. The hero is the picture. */
const CAPTION_MODES = ['sol', 'mine', 'none']
const captions = typeof a.captions === 'string' ? a.captions.trim().toLowerCase() : 'sol'
if (!CAPTION_MODES.includes(captions)) {
  console.error(`--captions must be one of ${CAPTION_MODES.join(', ')}; got "${a.captions}"`)
  process.exit(1)
}
/* The marker is deliberately not a plausible sentence. An empty string or a "TODO" reads as a
   design decision three stages later, and the failure being prevented is a real page shipping with
   placeholder text nobody noticed - so it has to look wrong at a glance and be greppable. */
const CAPTION_PLACEHOLDER = '<<WRITE THIS CAPTION>>'
/* Magenta by default, and the choice is not arbitrary: the key colour has to be one that cannot
   plausibly appear in the subject, and this pipeline's subjects are buildings, sites and
   machinery. Pure green loses to vegetation and safety gear; pure blue loses to sky, which is
   in shot on nearly every outdoor run. Nothing is magenta. */
const floatColor = typeof a['float-color'] === 'string' && a['float-color'].trim()
  ? a['float-color'].trim()
  : '#FF00FF'
const floating = !!a.float || (typeof a['float-color'] === 'string' && !!a['float-color'].trim())
if (floating && !/^#?[0-9a-fA-F]{6}$/.test(floatColor)) {
  console.error(`--float-color must be a 6-digit hex colour like "#FF00FF", got "${floatColor}"`)
  process.exit(1)
}
requireKey()

const steps = parseInt(a.steps || '6', 10)
/* Checked here rather than in the schema validator below, because that validator only runs after
   Sol has been billed. Two is the floor - a single keyframe has nothing to tween to, and the
   prompt would otherwise ask for "exactly 1 steps and 0 motions" and pay for the answer. */
if (!Number.isInteger(steps) || steps < 2) {
  console.error(`--steps must be a whole number of 2 or more, got "${a.steps}"`)
  process.exit(1)
}
const out = a.out || 'storyboard.json'

/* ---------- what the WHOLE run is going to cost ----------

   This is the first script in the pipeline that spends anything, and it is also the earliest
   point at which the END of the pipeline is priceable: --steps fixes how many stills
   keyframes.mjs will render and how many segments tween.mjs will order, so the full bill can be
   quoted here instead of discovered three stages and one approval later.

   None of it is being approved here. keyframes.mjs and tween.mjs each still ask before they
   spend, and the only thing this script buys is the single Sol call - much the smallest line in
   the forecast, and the reason there is no y/n prompt in front of it. A blocking gate over a
   figure that small is friction that teaches people to answer the next one by reflex, and the
   next one is the video bill.

   pricing.mjs is loaded dynamically and its absence is survivable, for two separate reasons. A
   forecast is advisory - the day it can stop a storyboard from being written it has stopped
   being a help. And the offline harness stages this script into a temp directory with only a
   generated kie.mjs beside it (test/helpers/harness.mjs, stageScript), so a static import would
   turn a missing sibling into ERR_MODULE_NOT_FOUND on paths that never spend a cent. The load
   failure is printed rather than swallowed: a cost line that quietly disappears is worse than
   one that was never written, because nobody notices it is gone. */
let pricing = null
try {
  pricing = await import('./pricing.mjs')
} catch (e) {
  console.log(`(no cost forecast - scripts/pricing.mjs did not load: ${String(e && e.message).split('\n')[0]})`)
}

/* Forecast-only inputs. They change nothing this script does; they exist so the number quoted
   below describes the run that is actually going to be ordered. The defaults are the defaults of
   the scripts that will spend - keyframes.mjs `--resolution 2K`, tween.mjs `--mode pro
   --duration 5` - and they have to be kept in step with them, because a run forecast at pro and
   then ordered at 4K is understated by 3.7x. An unknown mode or resolution is not fatal here:
   pricing.mjs prices what it can and names what it could not, which is the honest answer for a
   number nobody is being asked to approve. */
const fcResolution = a.resolution || '2K'
const fcMode = a.mode || 'pro'
const fcSeconds = Number(a.duration ?? 5)
/* --aspect and --resolution are forecast-only on the photo path and REAL on the seed path: the
   seed is rendered here, at these settings, and everything after it inherits the shape of that
   frame. Both are recorded in _meta so keyframes.mjs can default to them instead of to 16:9 and
   have the run silently change shape at step 2. */
const fcAspect = a.aspect || '16:9'

let forecast = null
let seedCost = null
if (pricing) {
  forecast = pricing.estimateRun({
    steps,
    seconds: fcSeconds,
    mode: fcMode,
    resolution: fcResolution,
    /* keyframes.mjs copies a supplied "after" photo in rather than rendering the final still, so
       --ref2 takes one image off the bill. It reads that from sb._meta.ref2, which is written
       from this same flag at the bottom of this file. */
    realAfter: !!a.ref2,
  })
  /* The seed is one more still at the same rate, so it is priced with the keyframe estimator and
     then re-kinded. The kind is the load-bearing part: `parts` is filtered by kind at the bottom of
     this file to separate money already spent from money still to approve, and a seed left as
     kind 'keyframes' would be quoted twice - once here, where it is actually bought, and again in
     the "still to approve" line for a still nobody is going to order. */
  if (seeding) {
    seedCost = { ...pricing.estimateKeyframes({ count: 1, resolution: fcResolution }), kind: 'seed' }
    forecast = pricing.combine([seedCost, ...forecast.parts], { kind: 'run', basis: forecast.basis })
  }
  console.log(`\nforecast for the whole run - ${forecast.basis || `${steps} steps`}:`)
  for (const l of pricing.formatBreakdown(forecast)) console.log('  ' + l)
  console.log(`\n  A forecast of work not yet approved. Only the ${seeding ? 'seed and storyboard lines are' : 'storyboard line is'} being spent now;`)
  console.log('  keyframes.mjs and tween.mjs each ask again before they generate anything.')
  /* Never throws, never retries, capped at 8s. A gate is allowed to proceed without this.

     Skipped on a dry run, and not for tidiness. On Windows, process.exit() after a fetch trips
     `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` - the same
     libuv bug doctor.mjs sidesteps by setting process.exitCode instead of exiting. The dry-run
     gate a few lines below DOES exit, so a balance lookup here turns every successful dry run on
     Windows into an assertion dump and exit code 127. Reproduced on Node 24.15.0. Affordability
     is doctor.mjs's job anyway; what a dry run is asked for is the price. */
  if (a['dry-run']) {
    console.log('  (balance not checked on a dry run - `node doctor.mjs` prints it, with every rate)')
  } else {
    console.log('  ' + pricing.formatBalance(await pricing.fetchBalance(), forecast))
  }
}

/* The earliest possible exit, and deliberately AFTER the forecast rather than before it: that
   number is the output of a dry run, not a thing being skipped. Placed above the seed branch
   because the seed is the first line item that costs real money on a run with no photo, and a
   --dry-run that drew a house would be a contradiction in terms. */
if (a['dry-run']) {
  console.log('\n--dry-run: nothing was sent and nothing was charged.')
  console.log(`  would ${seeding ? 'draw the opening frame from the idea, then ask' : 'ask'} Sol for a ${steps}-step storyboard`)
  if (seeding) console.log(`  opening frame  generated, ${fcAspect} at ${fcResolution}`)
  console.log(`  reference      ${seeding ? '(none given - seeded from the idea)' : a.ref}`)
  if (a.ref2) console.log(`  finished photo ${a.ref2}`)
  console.log(`  idea           ${a.idea}`)
  /* Echoed because they are the two flags that change what the frames LOOK like, and the two
     easiest to mistype into silence: --style takes any string, so a shell that ate the quotes
     passes a fragment, and --float is a boolean, so a typo is simply absent. A dry run that did
     not say which look it was planning would hide both. */
  if (style) console.log(`  art direction  ${style}`)
  if (floating) console.log(`  float          on, keying ${floatColor} to transparent at the frame stage`)
  console.log(`  would write    ${out}`)
  console.log('\nDrop --dry-run to run it.')
  process.exit(0)
}

const SYSTEM = `You write storyboards for scroll-scrubbed website heroes.

The hero is a chain of still keyframes joined by short AI video tweens generated with a
first-frame/last-frame model. That model produces a visible JUMP CUT if two consecutive
keyframes differ in camera position, lens, time of day, weather or composition. Your entire
job is to describe a sequence where the CAMERA NEVER MOVES and only the subject changes.

Rules that follow from that, and why:
- One fixed camera for every step. Never pan, orbit, push in, or change lens. If you find
  yourself writing "aerial view" for step 1 and "close up" for step 2, the tween will cut.
- Constant lighting and weather. "Golden hour" in one step and "midday" in the next reads as
  two different days and the model will cut between them.
- Each step changes ONE coherent thing. Big jumps force the video model to invent, and
  invention is what breaks continuity.
- Everything permanent in the reference photo stays: the house, fence, trees, neighbours,
  skyline. Only the work-in-progress area changes.
${style ? `\nART DIRECTION for every frame, and repeat it into every keyframePrompt so no single frame\ncan drift away from it: ${style}\n` : ''}${floating ? `\nBACKGROUND, in EVERY keyframePrompt and EVERY motion prompt: the subject stands alone on a\ncompletely flat, even field of solid ${floatColor}. Never describe sky, ground, horizon, cast\nshadow on the field, gradient or texture. The field is keyed to transparent afterwards, so it\nmust stay perfectly uniform while the subject changes - and nothing may move across it.\n` : ''}
For each keyframe write a prompt describing the SCENE AT REST in that state - what a photo
taken at that moment would show. Do not describe motion in a keyframe prompt.

For each gap between consecutive keyframes write a motion prompt describing ONE physical
process that carries the scene from the first state to the second. Keep it under 400
characters, present tense, concrete. This is what the video model animates.

Also give each step a short kicker label (2-4 words, like "Excavation" or "The shell") and a
caption sentence for the page - plain, specific, no marketing gloss.

Return STRICT JSON only, no prose, no code fence:
{
  "subject": "one line describing what is being transformed",
  "camera": "one line describing the locked camera, repeated into every prompt",
  "steps": [ { "id": 1, "label": "...", "caption": "...", "keyframePrompt": "..." } ],
  "motions": [ { "from": 1, "to": 2, "prompt": "..." } ]
}
There must be exactly ${steps} steps and ${steps - 1} motions.`

/* ---------- the seed, when there is no photograph ----------

   Two Sol calls rather than one, and the order matters. The obvious shortcut is to ask for the
   storyboard and a seed prompt in a single response, but then the keyframe prompts are written
   against a scene that does not exist yet, and the image comes back with a different fence, a
   different roofline and a different sun than the eleven prompts that were meant to describe it.
   So: idea -> seed description -> rendered frame -> storyboard written while LOOKING at that
   frame. From the second call onwards the seeded run and the photographed run are the same run,
   which is why nothing downstream needs to know which one it is.

   Low effort on purpose. This call writes one paragraph of description, not a schema, and the
   storyboard call below is where the reasoning budget earns its money. */
const SEED_SYSTEM = `You turn an idea into a single photographic image prompt.

The image is the FIRST FRAME of a scroll-scrubbed hero: a chain of stills joined by AI video
tweens, where the camera must never move again. Everything the rest of the sequence has to hold
constant is decided by this one frame, so describe it completely.

Write the STARTING state - before any of the work in the idea has happened. If the idea is
"build a house on an empty lot", this frame is the empty lot. Never depict the finished result.

The prompt must read as a real photograph, not a render or an illustration: a specific lens and
height, a specific time of day and weather, real materials, and the ordinary surroundings a real
site has - neighbouring buildings, power lines, kerbs, parked cars, vegetation. Give the frame
enough fixed furniture that later steps have something to keep identical.
${style ? `\nART DIRECTION, which overrides the photographic defaults above where they conflict: ${style}\n` : ''}${floating ? `\nBACKGROUND: the subject stands alone against a COMPLETELY FLAT, EVEN field of the solid colour ${floatColor}. No sky, no ground, no horizon, no shadow cast onto the field, no gradient, no texture, no vignette. That field is keyed out later, so anything in it is destroyed - put every part of the scene that matters INSIDE the subject.\n` : ''}
Return STRICT JSON only, no prose, no code fence:
{
  "seedPrompt": "the full image prompt, 60-150 words, one paragraph",
  "camera": "one line naming the locked camera: height, lens, angle, distance"
}`

let seedFile = null
let seedPrompt = null
if (seeding) {
  console.log('no --ref given: writing the opening frame from the idea...')
  const seedRaw = await sol([
    { role: 'system', content: [{ type: 'input_text', text: SEED_SYSTEM }] },
    { role: 'user', content: [{ type: 'input_text', text: `Idea: ${a.idea}\n\nAspect ratio: ${fcAspect}` }] },
  ], { effort: a.effort || 'low' })

  /* Same recovery the storyboard parse does - models fence JSON even when told not to. A seed that
     cannot be parsed falls back to the raw text as the prompt rather than exiting: the text IS a
     description of the scene either way, and refusing here would throw away a paid call over
     punctuation. Only a genuinely empty response is fatal. */
  let seedObj = null
  try {
    seedObj = JSON.parse(seedRaw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim())
  } catch (_) { /* fall through to the raw text */ }
  seedPrompt = (seedObj && typeof seedObj.seedPrompt === 'string' && seedObj.seedPrompt.trim())
    ? seedObj.seedPrompt.trim()
    : String(seedRaw || '').trim()
  if (!seedPrompt) {
    console.error('Sol returned nothing for the seed frame. Re-run, or pass --ref with a photo.')
    process.exit(1)
  }
  if (seedObj && typeof seedObj.camera === 'string' && seedObj.camera.trim()) {
    seedPrompt += `\n\nCamera: ${seedObj.camera.trim()}`
  }

  seedFile = out.replace(/\.json$/i, '') + '.seed.png'
  fs.mkdirSync(path.dirname(path.resolve(seedFile)), { recursive: true })
  console.log(`generating the seed frame (${fcAspect}, ${fcResolution})...`)
  const seedTask = await createTask('gpt-image-2-text-to-image', {
    prompt: seedPrompt, aspect_ratio: fcAspect, resolution: fcResolution,
  })
  const seedUrls = await pollTask(seedTask, { label: 'seed' })
  await download(seedUrls[0], seedFile)
  console.log(`  -> ${seedFile}`)
  console.log('  Look at it before going further. Everything after this frame is anchored to it,')
  console.log('  and re-running this script is far cheaper than re-running the video stage.')
}

/* From here the two paths are identical: one image on disk that is keyframe 1. */
const refPath = seeding ? seedFile : a.ref

console.log(`uploading reference${a.ref2 ? 's' : ''}...`)
/* Reach through to .url. uploadFile resolves to a {url, uploadedAt} RECORD - the timestamp exists
   so freshUrl() can tell whether the host's 24h TTL has expired. Binding that record to a name
   ending in "Url" and posting it straight into image_url is exactly what happened here, and it put
   an OBJECT on the wire where the Responses API wants a bare string. kie.ai answers that with a
   500, 500 is a retryable status, so a deterministic client-side type error spent 22.5s printing
   "500 from kie.ai, retrying" and blaming the vendor for our own payload. This stage has no use
   for the TTL - keyframes.mjs re-uploads the reference for itself - so take the string and let the
   variable name be true. */
const { url: refUrl } = await uploadFile(refPath)
const ref2Url = a.ref2 ? (await uploadFile(a.ref2)).url : null

const content = [
  { type: 'input_text', text:
    `Idea: ${a.idea}\n\nSteps required: ${steps}\n\n` +
    (ref2Url
      ? 'Two photos are attached: the FIRST is the real before state (this is keyframe 1) and ' +
        'the SECOND is the real finished state (this is the final keyframe). Write the steps in ' +
        'between so the sequence walks from the first photo to the second. Both anchors are real ' +
        'photographs, so describe them faithfully rather than inventing.'
      /* The seeded wording drops the word "real" and nothing else. Sol's job is identical either
         way - read the attached frame and progress from it - but telling it a generated image is a
         photograph invites it to "correct" details it thinks a real site would have, and those
         corrections are exactly the discontinuities the whole system exists to avoid. */
      : seeding
        ? 'One image is attached: the opening frame, generated a moment ago from this same idea. ' +
          'This is keyframe 1 - describe what is actually in it, down to the fixed surroundings, ' +
          'and progress from it. Do not add or move anything that is already visible.'
        : 'One photo is attached: the real starting state. This is keyframe 1 - describe it ' +
          'faithfully rather than inventing, then progress from it.') },
  { type: 'input_image', image_url: refUrl },
]
if (ref2Url) content.push({ type: 'input_image', image_url: ref2Url })

/* Name our own malformed payload before the server has to. sol() does not inspect what it is
   handed, so anything that is not a string here leaves as JSON and comes back as a bare 500 four
   retries and 22.5s later, reading like vendor flakiness. This costs nothing and is the difference
   between "storyboard.mjs sent the wrong type" and "kie.ai is down". */
for (const c of content) {
  if (c.type === 'input_image' && typeof c.image_url !== 'string') {
    console.error(`internal error: image_url must be a URL string, got ${typeof c.image_url}.`)
    console.error('That is a bug in storyboard.mjs, not a kie.ai failure. Nothing billable was sent.')
    process.exit(1)
  }
}

console.log('asking Sol for the storyboard (this takes a moment at medium effort)...')
const raw = await sol([
  { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
  { role: 'user', content },
], { effort: a.effort || 'medium' })

/* The receipt hits the disk before anything is allowed to reject it. Sol has been billed by this
   line, and everything below can exit or throw - the old code only saved the raw text inside the
   JSON.parse catch, so output that parsed but was structurally wrong died on a stack trace and
   took the paid response with it. Written unconditionally, because a guard that only runs on the
   failure path is a guard that has to predict the failure. */
const rawFile = out + '.raw.txt'
fs.writeFileSync(rawFile, raw)

/* Models sometimes fence JSON even when told not to - recover rather than failing the run */
const json = raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()
let sb
try {
  sb = JSON.parse(json)
} catch (e) {
  console.error(`Sol did not return parseable JSON. Raw output saved to ${rawFile}`)
  process.exit(1)
}

/* Everything past here validates model output, the one input in this pipeline nobody controls.
   Warning and writing anyway had two exits and both were bad. A missing `steps` made the motions
   check dereference undefined.length and die before the write, destroying the paid response. And
   the case that did NOT throw - a steps/motions count mismatch - wrote cleanly, passed every
   consumer, and surfaced three stages later in build-frames as a chapter captioned from the wrong
   clip. So: collect every complaint and refuse once, loudly, with the raw text still on disk. */
function refuse (problems) {
  console.error('\nSol returned a storyboard that does not match the schema:')
  problems.forEach(p => console.error(`  - ${p}`))
  console.error(`\nThe raw response is kept at ${rawFile} - you paid for it, so it is not discarded.`)
  console.error(`Correct it by hand and save it as ${out}, or re-run to ask again.`)
  process.exit(1)
}

const isText = (v) => typeof v === 'string' && v.trim().length > 0
if (!sb || typeof sb !== 'object' || Array.isArray(sb)) {
  refuse([`the response parsed as ${sb === null ? 'null' : Array.isArray(sb) ? 'an array' : typeof sb}, not a storyboard object`])
}

const bad = []
if (!Array.isArray(sb.steps) || !sb.steps.length) {
  bad.push(`steps must be a non-empty array (got ${Array.isArray(sb.steps) ? 'an empty array' : typeof sb.steps})`)
} else {
  if (sb.steps.length !== steps) bad.push(`expected ${steps} steps, got ${sb.steps.length}`)
  sb.steps.forEach((s, i) => {
    const who = `step ${Number.isInteger(s?.id) ? s.id : `#${i + 1}`}`
    if (!Number.isInteger(s?.id)) bad.push(`${who} has no integer id (got ${JSON.stringify(s?.id)})`)
    if (!isText(s?.label)) bad.push(`${who} has no label`)
    /* keyframePrompt is what gets rendered and billed at keyframes.mjs:110 - missing, it pays to
       draw the string "undefined" and the failure only shows up on the contact sheet. */
    if (!isText(s?.keyframePrompt)) bad.push(`${who} has no keyframePrompt`)
  })
  const ids = sb.steps.map(s => s?.id)
  if (new Set(ids).size !== ids.length) {
    /* Two different silent failures, both paid for: keyframes.mjs keys its state by step.id, so on
       a normal run the repeat prints "cached" and is never rendered even though the cost line
       promised it, and under --only both render and the second overwrites the first. */
    bad.push(`step ids must be unique, got [${ids.join(', ')}]`)
  } else if (ids.every(Number.isInteger) && ids.some((id, i) => id !== i + 1)) {
    /* keyframes.mjs reads st.frames[step.id - 1] for the continuity anchor and takes the LAST
       array entry as the final frame, so both assumptions have to hold at once. */
    bad.push(`step ids must run 1..${ids.length} in array order, got [${ids.join(', ')}]`)
  }
}

if (!Array.isArray(sb.motions)) {
  bad.push(`motions must be an array (got ${typeof sb.motions})`)
} else {
  /* Guarded by the steps check above - sb.steps.length - 1 on a missing steps array is the
     original crash, and reporting a derived count from a broken array is noise anyway. */
  if (Array.isArray(sb.steps) && sb.steps.length && sb.motions.length !== sb.steps.length - 1) {
    bad.push(`expected ${sb.steps.length - 1} motions for ${sb.steps.length} steps, got ${sb.motions.length}`)
  }
  const known = new Set(Array.isArray(sb.steps) ? sb.steps.map(s => s?.id) : [])
  sb.motions.forEach((m, i) => {
    const who = `motion #${i + 1} (${JSON.stringify(m?.from)} -> ${JSON.stringify(m?.to)})`
    if (known.size && (!known.has(m?.from) || !known.has(m?.to))) bad.push(`${who} does not join two real step ids`)
    if (!isText(m?.prompt)) bad.push(`${who} has no prompt`)
  })
  const froms = sb.motions.map(m => m?.from)
  if (new Set(froms).size !== froms.length) {
    /* tween.mjs keys segment state by m.from, so a repeat bills a second Kling render and then
       overwrites the first - a paid video that build-frames never emits a clip for. */
    bad.push(`motion "from" values must be unique, got [${froms.join(', ')}]`)
  }
}

if (bad.length) refuse(bad)

/* Promoted to a top-level field, beside `camera`, rather than left in _meta. keyframes.mjs appends
   `sb.camera` to every prompt it sends and has to do exactly the same with the style, or the art
   direction survives only as long as Sol remembered to copy it into each keyframePrompt - and the
   frame it forgets is the frame that comes back looking like a different company. Written from the
   flag, not from anything Sol returned, so the user's own words are what reach the renderer. */
if (style) sb.style = style
/* build-frames.mjs reads this to decide whether to key at all, and which colour to key. Carried
   on the storyboard rather than retyped as a flag three stages later, because a knockout done
   against a colour nobody rendered against removes nothing and looks exactly like a knockout
   that was never asked for. */
if (floating) sb.float = { color: floatColor }

/* Applied AFTER validation, never before. The schema check above insists every step has a caption,
   and it should keep insisting: a missing caption is still a malformed response from Sol, and
   letting --captions relax the validator would mean a broken storyboard passes whenever the user
   happened to ask for their own copy. So Sol is held to the same standard either way and the text
   is replaced once it has proved it produced some. */
sb.captions = captions
if (captions !== 'sol') {
  for (const step of sb.steps) step.caption = captions === 'none' ? '' : CAPTION_PLACEHOLDER
}

sb._meta = {
  ref: refPath, ref2: a.ref2 || null, refUrl, ref2Url, idea: a.idea,
  /* keyframes.mjs reads _meta.ref as "the photograph of the real place" and its ANCHOR prompt says
     so in those words. On a seeded run that is a generated image, and the difference is worth
     recording rather than losing: it is the one thing about the run that cannot be recovered by
     looking at the files. `seeded` also tells build-frames and any future consumer that the
     opening frame has no ground truth behind it. */
  seeded: seeding, seedPrompt,
  /* The shape the seed was actually rendered at, so keyframes.mjs does not default to 16:9 and
     change the aspect halfway through a portrait run. */
  aspect: fcAspect, resolution: fcResolution,
  /* Recorded as well as promoted, so a re-run knows what art direction produced the frames already
     on disk. Editing sb.style by hand and re-running --only is a legitimate repair; comparing it
     against what was originally asked for is only possible if the original is still written down. */
  style: style || null, float: floating ? floatColor : null,
  createdAt: new Date().toISOString(),
}
fs.writeFileSync(out, JSON.stringify(sb, null, 2))

console.log(`\nwrote ${out}`)
console.log(`subject: ${sb.subject}`)
console.log(`camera:  ${sb.camera}\n`)
sb.steps.forEach(s => console.log(`  ${String(s.id).padStart(2)}. ${String(s.label).padEnd(22)} ${s.caption}`))
/* Said here rather than left to be discovered at build-frames, because THIS is the moment someone
   would otherwise open the file, see markers where the copy should be, and assume the run failed. */
if (captions === 'mine') {
  console.log(`\n  --captions mine: every caption above is the marker ${CAPTION_PLACEHOLDER}.`)
  console.log(`  Write the real ones into ${out} before building frames; build-frames.mjs stops if`)
  console.log('  any survive, so placeholder copy cannot reach a page by accident.')
} else if (captions === 'none') {
  console.log('\n  --captions none: the page gets no text. Labels are kept for the contact sheet only.')
}
console.log(`\n${sb.steps.length} keyframes -> ${sb.steps.length - 1} video segments -> ${sb.steps.length - 1} scrub clips`)
/* The forecast again, minus the one line that has now actually been bought. Restated because
   this is the moment somebody decides whether to carry on, and the block at the top has a Sol
   call and a step list between it and here. Filtered by kind rather than sliced by position, so
   a reordering inside pricing.mjs cannot silently drop a stage out of the number. The label goes
   in `prefix` rather than after the figure: formatCost's own tail can carry a caveat and an
   "excludes:" clause, and anything appended behind those reads as part of them. */
if (forecast) {
  const spentHere = new Set(['storyboard', 'seed'])
  const ahead = pricing.combine(forecast.parts.filter(p => !spentHere.has(p.kind)), { kind: 'run' })
  console.log(pricing.formatCost(ahead, { prefix: 'Still to approve, across keyframes.mjs then tween.mjs: ' }))
}
console.log('Read the steps against the photo before generating keyframes.')
