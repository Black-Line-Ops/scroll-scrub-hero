/* --float cuts the subject out of its background so the hero sits ON the page rather than inside
   a rectangle. It is a key-colour knockout, not a segmentation model: the image model is told to
   render onto a flat field, and ffmpeg's colorkey turns that field into alpha during the pass that
   was already cutting the frames. No Python, no model download, no per-frame inference.

   The failure this is shaped around is a knockout that removes nothing. Key against a colour the
   frames were never rendered against and every frame comes out unchanged, at exit 0, with a config
   that says ALPHA and a hero that is still a rectangle. So the colour lives on the storyboard - the
   only artefact that knows what was actually rendered - and build-frames refuses rather than
   guesses when it is absent.

   What no test here can check is the edge quality on real Kling output: it animates the flat field
   too, and video compression leaves a halo of near-key pixels. --float-tolerance is the dial for
   that, and the contact sheet is where you look. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ff, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()

test('--float on the storyboard records the key colour for the stages that follow', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare bench to finished part', '--steps', '4', '--out', out, '--float'])

  assert.equal(r.status, 0, r.out)
  const sent = fs.readFileSync(path.join(dir, 'sol-call.json'), 'utf8')
  assert.match(sent, /completely flat, even field/i)
  assert.match(sent, /#FF00FF/)

  const sb = JSON.parse(fs.readFileSync(out, 'utf8'))
  /* Magenta by default and the choice is load-bearing: green loses to vegetation and safety gear,
     blue loses to sky, and sky is in shot on nearly every outdoor run. */
  assert.equal(sb.float.color, '#FF00FF')
  assert.equal(sb._meta.float, '#FF00FF')
})

test('a --float-color that is not a colour is refused before Sol is billed', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'x to y', '--out', path.join(dir, 'storyboard.json'), '--float-color', 'magenta'])

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /6-digit hex colour/)
  assert.equal(fs.existsSync(path.join(dir, 'sol-call.json')), false)
})

test('without --float nothing about the prompts or the storyboard changes', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'x to y', '--steps', '4', '--out', out])

  assert.equal(r.status, 0, r.out)
  assert.equal(fs.readFileSync(path.join(dir, 'sol-call.json'), 'utf8').includes('FLAT'), false)
  const sb = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal('float' in sb, false)
  assert.equal(sb._meta.float, null)
})

test('keyframes.mjs repeats the background rule into every prompt', () => {
  const dir = stageScript('keyframes.mjs', { also: ['pricing.mjs'] })
  const sb = storyboard(4)
  sb.float = { color: '#FF00FF' }
  sb._meta = { ref: write(path.join(dir, 'yard.jpg'), 'placeholder'), seeded: false }
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const r = runScript(dir, 'keyframes.mjs',
    ['--storyboard', sbFile, '--out', path.join(dir, 'keyframes'), '--yes', '--dry-run'])

  assert.equal(r.status, 0, r.out)
  /* Per frame, not once. One frame rendered on a sky instead of the flat field is not a slightly
     wrong frame - it keys to a ragged hole, and it is found after every still has been paid for. */
  const seen = (r.stdout.match(/BACKGROUND \(identical in every frame\)/g) || []).length
  assert.equal(seen, sb.steps.length, `expected ${sb.steps.length} prompts to carry it, saw ${seen}`)
})

/* ---- the ffmpeg half: does the key actually produce alpha ---- */

function floatScene ({ argv = [], float = { color: '#FF00FF' } } = {}) {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sb = storyboard(3)
  if (float) sb.float = float
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const segments = {}
  for (const from of [1, 2]) {
    const file = path.join(segDir, `segment-0${from}.mp4`)
    makeClip(file, { seconds: 1, source: 'color=c=0xFF00FF:s=64x36:d=1:r=25[bg];' +
      'color=c=0x22AA44:s=24x16:d=1:r=25[fg];[bg][fg]overlay=20:10' })
    segments[from] = { from, to: from + 1, file, duration: 1 }
  }
  write(path.join(segDir, '_state.json'), { segments })
  const outDir = path.join(dir, 'frames')
  const r = runScript(dir, 'build-frames.mjs',
    ['--segments', segDir, '--storyboard', sbFile, '--out', outDir, '--per-clip', '3', '--width', '160', ...argv])
  const cfgFile = path.join(outDir, 'config.js')
  return { ...r, outDir, cfg: fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null }
}

test('build-frames keys the recorded colour out and the frames carry an alpha channel',
  { skip: FF.ok ? false : FF.why }, () => {
    const r = floatScene()

    assert.equal(r.status, 0, r.out)
    assert.match(r.stdout, /keying #FF00FF to transparent/)
    /* The claim is about the file, not about the log line. A WebP with alpha is an extended-format
       file (VP8X) carrying an ALPH chunk; a plain one is VP8 and carries neither. */
    const file = path.join(r.outDir, 'clip1', 'frame-0001.webp')
    const frame = fs.readFileSync(file)
    assert.equal(frame.slice(12, 16).toString(), 'VP8X', 'not an extended WebP, so it cannot hold alpha')
    assert.equal(frame.includes(Buffer.from('ALPH')), true, 'no alpha chunk - nothing was keyed')

    /* The container saying it can hold alpha is not the claim. Decode it and look: the field must
       be gone and the subject must still be there. A key that removed everything, or nothing,
       produces a perfectly valid alpha WebP and would pass every assertion above. */
    const raw = path.join(r.outDir, 'decoded.rgba')
    ff(['-i', file, '-pix_fmt', 'rgba', '-f', 'rawvideo', raw])
    const px = fs.readFileSync(raw)
    let clear = 0, solid = 0
    for (let i = 3; i < px.length; i += 4) { if (px[i] === 0) clear++; else if (px[i] === 255) solid++ }
    assert.ok(clear > 0, 'no transparent pixels - the background was not keyed out')
    assert.ok(solid > 0, 'no opaque pixels - the key ate the subject as well as the field')
    /* The page has to know: a knocked-out hero is meant to sit on the page's own background, and a
       wrapper that paints one behind the canvas throws the whole effect away. */
    assert.match(r.cfg, /window\.HERO_ALPHA=true/)
  })

test('a storyboard with no key colour refuses rather than keying against a guess',
  { skip: FF.ok ? false : FF.why }, () => {
    const r = floatScene({ float: null, argv: ['--float'] })

    assert.equal(r.status, 1, r.out)
    assert.match(r.stderr, /this storyboard did not record one/)
    /* The bad outcome being prevented is not a crash. It is a run that keys against the wrong
       colour, removes nothing, exits 0, and writes a config claiming alpha. */
    assert.equal(r.cfg, null)
  })

test('no float means no alpha and no ALPHA line', { skip: FF.ok ? false : FF.why }, () => {
  const r = floatScene({ float: null })

  assert.equal(r.status, 0, r.out)
  const frame = fs.readFileSync(path.join(r.outDir, 'clip1', 'frame-0001.webp'))
  assert.equal(frame.includes(Buffer.from('ALPH')), false, 'alpha appeared without being asked for')
  assert.equal(r.cfg.includes('_ALPHA'), false)
})

test('--float-tolerance is validated, because it is the dial people reach for',
  { skip: FF.ok ? false : FF.why }, () => {
    const r = floatScene({ argv: ['--float-tolerance', '4'] })

    assert.equal(r.status, 1, r.out)
    assert.match(r.stderr, /fraction between 0 and 1/)
  })
