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

/* what will actually be generated, so the user can see the bill before it starts */
const planned = sb.steps.filter(s => (only ? only.includes(s.id) : !st.frames[s.id]))
const lastId = sb.steps[sb.steps.length - 1].id
const usingRealAfter = !!sb._meta?.ref2
const toGenerate = planned.filter(s => !(usingRealAfter && s.id === lastId))

if (!toGenerate.length && !usingRealAfter) { console.log('nothing to generate - all keyframes are cached'); process.exit(0) }

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
   a real image over a synthesised one. Keep its true extension: renaming a JPEG to .png makes
   the uploader advertise the wrong MIME type. */
if (usingRealAfter && !st.frames[lastId]) {
  const src = sb._meta.ref2
  const dest = path.join(outDir, `keyframe-${String(lastId).padStart(2, '0')}${path.extname(src) || '.jpg'}`)
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

/* Contact sheet: the point is to make disagreements between adjacent frames obvious, so they
   are shown in order at equal size with the label under each. */
const cards = sb.steps.map(s => {
  const f = st.frames[s.id]
  const src = f ? path.basename(f.file) : ''
  return `<figure>
    <span class="n">${String(s.id).padStart(2, '0')}</span>
    ${src ? `<img src="${src}" alt="">` : '<div class="missing">not generated</div>'}
    <figcaption><b>${s.label}</b><span>${s.caption}</span></figcaption>
  </figure>`
}).join('\n')

fs.writeFileSync(path.join(outDir, 'contact-sheet.html'), `<!doctype html>
<meta charset="utf-8"><title>Keyframes — ${sb.subject || ''}</title>
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
<h1>${sb.subject || 'Keyframes'}</h1>
<p class="sub">${sb.steps.length} keyframes → ${sb.steps.length - 1} video segments. Camera: ${sb.camera || 'locked'}</p>
<div class="grid">${cards}</div>
<div class="tip">Compare each frame with the one before it. Anything permanent that changed —
the house, fence, trees, skyline, light — will show up as a jump cut in the finished hero.
Note the numbers to redo, then re-run with <code>--only 3,5</code>.
<br><br>Nothing has been charged for video yet. The next step is the expensive one.</div>
`)

console.log(`\ncontact sheet: ${path.join(outDir, 'contact-sheet.html')}`)
console.log('Open it, review with the user, and do NOT run tween.mjs until they approve.')
