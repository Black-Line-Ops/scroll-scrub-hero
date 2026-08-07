/* Step 1: reference photo + idea -> storyboard.json
   Sol is multimodal, so it can actually look at the property and write steps that reference
   what is there. That is the whole reason for using it rather than writing prompts blind. */
import fs from 'node:fs'
import { requireKey, uploadFile, sol, args } from './kie.mjs'

const a = args()
/* Type-check, not truth-check. `a` is produced by the parser, so a guard that trusts the parser
   cannot catch the parser being wrong - and it once was: `--idea --steps 6` bound the boolean true
   to idea, `!true` is false, this guard waved it through, and kie.ai was paid to storyboard the
   literal string "Idea: true". kie.mjs rejects that argv now, but the two ends stay independent on
   purpose. A validation guard that only works when its input is already correct is not a guard. */
if (typeof a.ref !== 'string' || typeof a.idea !== 'string' || !a.idea.trim()) {
  console.error('usage: node storyboard.mjs --ref <photo> --idea "<idea>" [--steps 6] [--ref2 <after-photo>] [--out storyboard.json]')
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

console.log(`uploading reference${a.ref2 ? 's' : ''}...`)
/* Reach through to .url. uploadFile resolves to a {url, uploadedAt} RECORD - the timestamp exists
   so freshUrl() can tell whether the host's 24h TTL has expired. Binding that record to a name
   ending in "Url" and posting it straight into image_url is exactly what happened here, and it put
   an OBJECT on the wire where the Responses API wants a bare string. kie.ai answers that with a
   500, 500 is a retryable status, so a deterministic client-side type error spent 22.5s printing
   "500 from kie.ai, retrying" and blaming the vendor for our own payload. This stage has no use
   for the TTL - keyframes.mjs re-uploads the reference for itself - so take the string and let the
   variable name be true. */
const { url: refUrl } = await uploadFile(a.ref)
const ref2Url = a.ref2 ? (await uploadFile(a.ref2)).url : null

const content = [
  { type: 'input_text', text:
    `Idea: ${a.idea}\n\nSteps required: ${steps}\n\n` +
    (ref2Url
      ? 'Two photos are attached: the FIRST is the real before state (this is keyframe 1) and ' +
        'the SECOND is the real finished state (this is the final keyframe). Write the steps in ' +
        'between so the sequence walks from the first photo to the second. Both anchors are real ' +
        'photographs, so describe them faithfully rather than inventing.'
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

sb._meta = { ref: a.ref, ref2: a.ref2 || null, refUrl, ref2Url, idea: a.idea, createdAt: new Date().toISOString() }
fs.writeFileSync(out, JSON.stringify(sb, null, 2))

console.log(`\nwrote ${out}`)
console.log(`subject: ${sb.subject}`)
console.log(`camera:  ${sb.camera}\n`)
sb.steps.forEach(s => console.log(`  ${String(s.id).padStart(2)}. ${String(s.label).padEnd(22)} ${s.caption}`))
console.log(`\n${sb.steps.length} keyframes -> ${sb.steps.length - 1} video segments -> ${sb.steps.length - 1} scrub clips`)
console.log('Read the steps against the photo before generating keyframes.')
