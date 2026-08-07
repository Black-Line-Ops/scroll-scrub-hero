/* Step 2: storyboard -> keyframe stills + a contact sheet for human approval.
   This is the gate. Stills are cheap and video is not, so everything gets looked at here.

   Each keyframe is generated from the ORIGINAL photo plus the PREVIOUS keyframe:
     - the original anchors camera, architecture and surroundings so the scene cannot drift
       into a generic AI version of itself over six steps
     - the previous keyframe carries continuity so step 4 reads as step 3 with work done
   Using only one of the two fails predictably: original-only loses continuity,
   previous-only compounds drift. */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireKey, uploadFile, createTask, pollTask, download, state, args, confirm } from './kie.mjs'

const a = args()
if (!a.storyboard) {
  console.error('usage: node keyframes.mjs --storyboard storyboard.json [--ref <photo>] [--out keyframes/]\n' +
    '                        [--only 3,5] [--prompt "override for --only"] [--aspect 16:9] [--resolution 2K] [--yes]')
  process.exit(1)
}
requireKey()

const sb = JSON.parse(fs.readFileSync(a.storyboard, 'utf8'))
const outDir = path.resolve(a.out || 'keyframes')
const aspect = a.aspect || '16:9'
const resolution = a.resolution || '2K'
const stateFile = path.join(outDir, '_state.json')
const st = state.load(stateFile)
fs.mkdirSync(outDir, { recursive: true })

const only = a.only ? String(a.only).split(',').map(s => parseInt(s.trim(), 10)) : null
st.frames = st.frames || {}

/* Everything below indexes sb.steps, including the line that takes the last array entry as the
   finished stage. Measured: `"steps": []` reached that as sb.steps[-1].id and died with
   `TypeError: Cannot read properties of undefined (reading 'id')`, and a storyboard with no steps
   key at all died one line earlier on .filter(). Neither names the file or the problem, which is
   a poor way to tell someone their JSON is broken. */
if (!Array.isArray(sb.steps) || !sb.steps.length) {
  console.error(`${a.storyboard} has no steps to generate keyframes from (steps must be a non-empty array).`)
  process.exit(1)
}
const stepIds = sb.steps.map(s => s.id)

/* --only naming a keyframe the storyboard does not have used to filter the list down to nothing
   and then report "all keyframes are cached" at exit 0 - the opposite of the truth, at the one
   moment an operator is deciding whether the run is finished. A mistyped id is a stop, not a
   no-op. tween.mjs:67 already refuses this for segments; keyframes was left without it, so
   --only 99 and --only 0 both certified a run that had generated nothing. */
if (only) {
  const unknown = only.filter(id => !stepIds.includes(id))
  if (unknown.length) {
    console.error(`--only ${unknown.join(',')}: no such keyframe in ${a.storyboard}.`)
    console.error(`Keyframes are named by their step id: ${stepIds.join(', ')}`)
    process.exit(1)
  }
}

/* what will actually be generated, so the user can see the bill before it starts */
const planned = sb.steps.filter(s => (only ? only.includes(s.id) : !st.frames[s.id]))
const lastId = sb.steps[sb.steps.length - 1].id
const usingRealAfter = !!sb._meta?.ref2
const toGenerate = planned.filter(s => !(usingRealAfter && s.id === lastId))

/* Copying the supplied "after" photo in is free but it is still work, so it has to keep the run
   alive. Once it is on disk there is nothing left to do and this run is a no-op like any other -
   the old condition tested `usingRealAfter` instead, which made an all-cached --ref2 run take a
   different path forever, re-uploading the reference to reach a loop that generates nothing. */
const realAfterPending = usingRealAfter && !st.frames[lastId]

if (!toGenerate.length && !realAfterPending) {
  console.log('nothing to generate - all keyframes are cached')
  /* Still write the sheet. It is the human approval gate, and a run with nothing to generate is
     precisely when someone is trying to get the gate back - the file was deleted, or a keyframe
     was swapped on disk by hand. Rebuilding the artifact must not cost another image.
     (writeSheet is a hoisted declaration further down, next to the markup it owns.) */
  writeSheet()
  process.exit(0)
}

/* Everything past this point does arithmetic on step ids. `lastId` above takes the id of the LAST
   array entry and treats it as the finished stage, and the generate loop reaches for the
   continuity anchor as `st.frames[step.id - 1]`. Both are true only while the ids run 1..n in
   array order. storyboard.mjs:165 enforces that on what Sol returns, but a hand-repaired
   storyboard.json never passes through the producer, and the failure is silent and billed:
   measured against the offline harness, ids 1,3,2,4 walked straight past the cost line and
   reached createTask() under --yes. The frame for step 2 is anchored to st.frames[1] - step 1's
   photograph - when the step actually before it in that chain is step 3, so the anchor is wrong
   and the wrongness is invisible until the finished hero jump-cuts.

   It sits below the all-cached exit rather than above it deliberately. That exit exists so a
   deleted contact sheet can be rebuilt without paying, and writeSheet() does no id arithmetic at
   all: it walks sb.steps in array order and looks each frame up by its exact id. Refusing there
   would take away the one repair that costs nothing, and by then there is nothing left to index
   wrongly. Every path that does index - anything to generate, or a --ref2 copy still pending -
   passes through here first. */
if (stepIds.some((id, i) => id !== i + 1)) {
  console.error(`${a.storyboard}: step ids must run 1..${stepIds.length} in array order, got [${stepIds.join(', ')}].`)
  console.error('The previous keyframe is looked up as id - 1 and the finished stage is the last entry in the array, so')
  console.error('out-of-order ids anchor a frame to the wrong photograph and pay for it. Renumber the steps and their motions.')
  process.exit(1)
}

if (toGenerate.length) {
  const costLine =
    `\nAbout to generate ${toGenerate.length} keyframe still(s)\n` +
    `  model       gpt-image-2-image-to-image\n` +
    `  size        ${resolution} at ${aspect}\n` +
    `  keyframes   ${toGenerate.map(s => s.id).join(', ')}\n` +
    '\nStills are the cheap half of this pipeline, but they are not free. Per-image pricing\n' +
    'is on kie.ai; this script does not know your rate and will not invent one.'
  console.log(costLine)
  if (!await confirm('Generate these stills?', { yes: !!a.yes, whatItCosts: costLine })) {
    console.log('aborted - nothing generated, nothing charged')
    process.exit(1)
  }
}

let refUrlRec = st.refUrlRec
if (!refUrlRec) {
  const ref = a.ref || sb._meta?.ref
  if (!ref || !fs.existsSync(ref)) { console.error(`reference photo not found: ${ref || '(none given, pass --ref)'}`); process.exit(1) }
  console.log('uploading reference...')
  refUrlRec = await uploadFile(ref)
  st.refUrlRec = refUrlRec
  state.save(stateFile, st)
}

/* If the user supplied a real "after" photo, the final keyframe is that photo - always prefer
   a real image over a synthesised one. Keep its extension where we recognise it, so the copy on
   disk still looks like what it is - but whitelist rather than trust it. path.extname() returns
   everything after the last dot, quotes and angle brackets included, and this name is later
   interpolated into an HTML attribute in the contact sheet: a file called
   `after.jpg" onerror="..."` would break out of that attribute even if the model output is clean.
   Falling back to .jpg is safe because nothing downstream reads the type off the name - uploadFile
   sniffs the magic bytes, and ffmpeg/ffprobe read the content. */
const KNOWN_EXT = ['.jpg', '.jpeg', '.png', '.webp']
if (realAfterPending) {
  const src = sb._meta.ref2
  const ext = path.extname(src).toLowerCase()
  const dest = path.join(outDir, `keyframe-${String(lastId).padStart(2, '0')}${KNOWN_EXT.includes(ext) ? ext : '.jpg'}`)
  fs.copyFileSync(src, dest)
  st.frames[lastId] = { file: dest, source: 'real photo (--ref2)' }
  state.save(stateFile, st)
  console.log(`keyframe ${lastId}: using the supplied finished photo (${path.basename(dest)})`)
  /* A real photo that is a different shape from the generated frames makes the last tween
     letterbox or crop. Worth knowing now rather than after paying for the segment. */
  try {
    const d = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height',
      '-of', 'json', dest], { encoding: 'utf8' })).streams?.[0]
    if (d?.width && d?.height) {
      const got = d.width / d.height
      const [aw, ah] = aspect.split(':').map(Number)
      const want = aw / ah
      if (Math.abs(got - want) / want > 0.08) {
        console.log(`  !! that photo is ${d.width}x${d.height} (${got.toFixed(2)}:1) but the generated frames are ${aspect} (${want.toFixed(2)}:1).`)
        console.log('     The final tween will crop or letterbox. Crop it to match before continuing if that matters.')
      }
    }
  } catch (_) { /* ffprobe is optional here - the warning is a nicety, not a gate */ }
}

const CAMERA = sb.camera ? `\n\nCAMERA (identical in every frame, never deviate): ${sb.camera}` : ''
const ANCHOR = '\n\nThe first attached image is the real location: keep its camera angle, framing, ' +
  'architecture, fence, trees, neighbouring buildings, horizon, time of day and weather EXACTLY. ' +
  'Change only what the description says changes. This is a photograph of a real place, not a concept.'
const CONTINUITY = ' The second attached image is the previous step; this frame must look like that ' +
  'same photograph with the described work done, not a different property.'

for (const step of sb.steps) {
  if (only && !only.includes(step.id)) continue
  if (usingRealAfter && step.id === lastId) continue
  if (st.frames[step.id] && !only) { console.log(`keyframe ${step.id}: cached`); continue }

  const prev = st.frames[step.id - 1]
  const inputs = [refUrlRec.url]
  if (prev?.url) inputs.push(prev.url)

  const prompt = (only && a.prompt ? a.prompt : step.keyframePrompt) +
    CAMERA + ANCHOR + (prev?.url ? CONTINUITY : '')

  console.log(`keyframe ${step.id} (${step.label})...`)
  const taskId = await createTask('gpt-image-2-image-to-image', {
    prompt, input_urls: inputs, aspect_ratio: aspect, resolution,
  })
  const urls = await pollTask(taskId, { label: `kf${step.id}` })
  const dest = path.join(outDir, `keyframe-${String(step.id).padStart(2, '0')}.png`)
  await download(urls[0], dest)

  /* Persist the paid-for file IMMEDIATELY. Waiting until after the re-upload means a failure
     in between throws away an image that has already been billed. */
  st.frames[step.id] = { file: dest, prompt, taskId }
  state.save(stateFile, st)

  try {
    const rec = await uploadFile(dest)
    Object.assign(st.frames[step.id], rec)
    state.save(stateFile, st)
  } catch (e) {
    console.log(`  (saved, but re-upload failed: ${e.message} - it will be uploaded when needed)`)
  }
  console.log(`  -> ${dest}`)
}

/* Every string on this page came from somewhere untrusted: the labels and captions are Sol's
   description of a photograph a client emailed in, and the filename is whatever the operator
   typed after --ref2. Unescaped, `<b>` in a caption is the harmless version and a `<script>` in
   the subject is the other one - and the subject sits in <title>, which is RCDATA, so the first
   `</title>` in the payload ends the element and the rest executes in <head> before the page
   renders. That would let an injection rewrite the one human check standing between the operator
   and the expensive Kling stage.
   Declared with `function` rather than as a const arrow so it is hoisted alongside writeSheet() -
   the all-cached early exit above calls that before this line is reached. */
function esc (s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

/* Contact sheet: the point is to make disagreements between adjacent frames obvious, so they
   are shown in order at equal size with the label under each. */
function writeSheet () {
  const cards = sb.steps.map(s => {
    const f = st.frames[s.id]
    const src = f ? path.basename(f.file) : ''
    return `<figure>
    <span class="n">${esc(String(s.id).padStart(2, '0'))}</span>
    ${src ? `<img src="${esc(src)}" alt="">` : '<div class="missing">not generated</div>'}
    <figcaption><b>${esc(s.label)}</b><span>${esc(s.caption)}</span></figcaption>
  </figure>`
  }).join('\n')

  /* Belt and braces behind esc(): no script of any kind can run here, and nothing can leave the
     machine, so a sink someone forgets to wrap later degrades to mangled text instead of code.
     `file:` is listed alongside 'self' because this page is opened by double-clicking it, and how
     a file:// document's origin matches 'self' has never been consistent across browsers. Chrome
     140 loads the frames either way (measured), but a browser that disagrees would render the
     sheet with every frame blank - which destroys the artifact this whole step exists to produce.
     Naming the scheme costs nothing: it permits a local image on a page already loaded from disk,
     and script of any origin stays blocked by default-src 'none'. */
  fs.writeFileSync(path.join(outDir, 'contact-sheet.html'), `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'">
<title>Keyframes — ${esc(sb.subject || '')}</title>
<style>
 body{margin:0;padding:28px;background:#10141a;color:#e8eef5;font:14px/1.5 system-ui,sans-serif}
 h1{font-size:17px;margin:0 0 4px} p.sub{margin:0 0 22px;color:#8ea1b5}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:18px}
 figure{margin:0;background:#161c24;border:1px solid #26313d;border-radius:10px;overflow:hidden;position:relative}
 img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover;background:#0b0f14}
 .missing{aspect-ratio:16/9;display:grid;place-items:center;color:#5d6f82}
 .n{position:absolute;top:10px;left:10px;z-index:1;background:rgba(6,10,14,.82);border-radius:6px;
    padding:3px 9px;font:600 12px ui-monospace,monospace;letter-spacing:.08em}
 figcaption{padding:11px 13px;display:flex;flex-direction:column;gap:3px}
 figcaption b{font-size:13px} figcaption span{color:#8ea1b5;font-size:12.5px}
 .tip{margin-top:24px;padding:13px 15px;background:#161c24;border:1px solid #26313d;border-radius:10px;color:#a8b8c8}
</style>
<h1>${esc(sb.subject || 'Keyframes')}</h1>
<p class="sub">${sb.steps.length} keyframes → ${sb.steps.length - 1} video segments. Camera: ${esc(sb.camera || 'locked')}</p>
<div class="grid">${cards}</div>
<div class="tip">Compare each frame with the one before it. Anything permanent that changed —
the house, fence, trees, skyline, light — will show up as a jump cut in the finished hero.
Note the numbers to redo, then re-run with <code>--only 3,5</code>.
<br><br>Nothing has been charged for video yet. The next step is the expensive one.</div>
`)

  console.log(`\ncontact sheet: ${path.join(outDir, 'contact-sheet.html')}`)
  console.log('Open it, review with the user, and do NOT run tween.mjs until they approve.')
}

writeSheet()
