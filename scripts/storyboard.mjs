/* Step 1: reference photo + idea -> storyboard.json
   Sol is multimodal, so it can actually look at the property and write steps that reference
   what is there. That is the whole reason for using it rather than writing prompts blind. */
import fs from 'node:fs'
import { requireKey, uploadFile, sol, args } from './kie.mjs'

const a = args()
if (!a.ref || !a.idea) {
  console.error('usage: node storyboard.mjs --ref <photo> --idea "<idea>" [--steps 6] [--ref2 <after-photo>] [--out storyboard.json]')
  process.exit(1)
}
requireKey()

const steps = parseInt(a.steps || '6', 10)
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
const refUrl = await uploadFile(a.ref)
const ref2Url = a.ref2 ? await uploadFile(a.ref2) : null

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

console.log('asking Sol for the storyboard (this takes a moment at medium effort)...')
const raw = await sol([
  { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
  { role: 'user', content },
], { effort: a.effort || 'medium' })

/* Models sometimes fence JSON even when told not to - recover rather than failing the run */
const json = raw.replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim()
let sb
try {
  sb = JSON.parse(json)
} catch (e) {
  fs.writeFileSync(out + '.raw.txt', raw)
  console.error(`Sol did not return parseable JSON. Raw output saved to ${out}.raw.txt`)
  process.exit(1)
}

if (!Array.isArray(sb.steps) || sb.steps.length !== steps) {
  console.warn(`  warning: expected ${steps} steps, got ${sb.steps?.length}`)
}
if (!Array.isArray(sb.motions) || sb.motions.length !== sb.steps.length - 1) {
  console.warn(`  warning: expected ${sb.steps.length - 1} motions, got ${sb.motions?.length}`)
}

sb._meta = { ref: a.ref, ref2: a.ref2 || null, refUrl, ref2Url, idea: a.idea, createdAt: new Date().toISOString() }
fs.writeFileSync(out, JSON.stringify(sb, null, 2))

console.log(`\nwrote ${out}`)
console.log(`subject: ${sb.subject}`)
console.log(`camera:  ${sb.camera}\n`)
sb.steps.forEach(s => console.log(`  ${String(s.id).padStart(2)}. ${String(s.label).padEnd(22)} ${s.caption}`))
console.log(`\n${sb.steps.length} keyframes -> ${sb.steps.length - 1} video segments -> ${sb.steps.length - 1} scrub clips`)
console.log('Read the steps against the photo before generating keyframes.')
