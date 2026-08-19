/* Who writes the words on the client's website.

   Every stage carries a kicker and a caption, and they reach config.js as `k` and `t` - rendered
   on a live page, beside a client's logo, as marketing copy. Until --captions existed, Sol wrote
   them and nobody chose that; it was just what happened, and the first anyone saw of the words was
   storyboard.json, after the call was paid for. For an agency that is a different class of risk
   from a model drawing a fence in the wrong place, and it deserved a decision rather than a default.

   The interesting case is `mine`, and it is interesting because of how it fails. Every stage
   between the storyboard and the page treats a caption as an opaque string, so a placeholder
   travels the entire pipeline without one complaint and lands on the site. The marker therefore has
   to be unmistakable, and something has to refuse to build a page out of it - before the frame
   tree is touched, because build-frames rebuilds each clip directory by deleting it first. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()
const PLACEHOLDER = '<<WRITE THIS CAPTION>>'

function board (argv = []) {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare yard to pool', '--steps', '4', '--out', out, ...argv])
  return { ...r, dir, out, sb: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null }
}

test('the default is unchanged: Sol writes the captions', () => {
  const r = board()

  assert.equal(r.status, 0, r.out)
  assert.equal(r.sb.captions, 'sol')
  /* The fixture's own captions, untouched. A default that quietly started rewriting them would be
     a silent change to every existing user's output. */
  for (const s of r.sb.steps) {
    assert.ok(s.caption && !s.caption.includes(PLACEHOLDER), `step ${s.id} lost its caption`)
  }
})

test('--captions none strips the text and keeps the labels', () => {
  const r = board(['--captions', 'none'])

  assert.equal(r.status, 0, r.out)
  assert.equal(r.sb.captions, 'none')
  for (const s of r.sb.steps) {
    assert.equal(s.caption, '', `step ${s.id} still has a caption`)
    /* Labels are internal - the contact sheet uses them to tell frames apart - so they survive.
       Stripping those too would make the approval gate unreadable to save nothing. */
    assert.ok(s.label, `step ${s.id} lost its label, which the contact sheet needs`)
  }
  assert.match(r.stdout, /the page gets no text/)
})

test('--captions mine marks every caption unmistakably', () => {
  const r = board(['--captions', 'mine'])

  assert.equal(r.status, 0, r.out)
  assert.equal(r.sb.captions, 'mine')
  for (const s of r.sb.steps) assert.equal(s.caption, PLACEHOLDER)
  assert.ok(r.sb.steps.every(s => s.label), 'labels are still needed for the contact sheet')
  /* Said at the storyboard, not left for build-frames. This is the moment someone opens the file,
     sees markers where copy should be, and concludes the run failed. */
  assert.match(r.stdout, /Write the real ones into/)
})

test('an unknown --captions value is refused before Sol is billed', () => {
  const r = board(['--captions', 'chatgpt'])

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /--captions must be one of sol, mine, none/)
  assert.equal(fs.existsSync(path.join(r.dir, 'sol-call.json')), false, 'a typo should cost nothing')
})

test('the schema is still enforced when the user is writing the copy', () => {
  /* The tempting shortcut is to relax validation under --captions mine, since the captions are
     about to be thrown away. That would mean a genuinely malformed Sol response - one that paid for
     nothing usable - passes silently whenever the user happened to want their own words. Sol is
     held to the same standard either way and the text is replaced only after it has proved it
     produced some. */
  const broken = storyboard(4)
  delete broken.steps[2].caption
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(broken) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'x to y', '--steps', '4', '--out', out, '--captions', 'mine'])

  /* The repo's schema requires a label and a keyframePrompt but not a caption, so this must still
     SUCCEED - the assertion is that --captions did not change the verdict either way, and that the
     receipt survives regardless. */
  assert.equal(fs.existsSync(out + '.raw.txt'), true, 'the paid response must always reach disk')
  if (r.status === 0) {
    const sb = JSON.parse(fs.readFileSync(out, 'utf8'))
    assert.equal(sb.steps[2].caption, PLACEHOLDER, 'a missing caption should still be marked')
  } else {
    assert.match(r.stderr, /does not match the schema/)
  }
})

test('build-frames refuses to make a page out of placeholder copy', { skip: FF.ok ? false : FF.why }, () => {
  const dir = stageScript('build-frames.mjs')
  const sb = storyboard(3)
  sb.captions = 'mine'
  sb.steps[1].caption = PLACEHOLDER          /* one written, one not - the realistic mistake */
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const segDir = path.join(dir, 'segments')
  const segments = {}
  for (const from of [1, 2]) {
    const file = path.join(segDir, `segment-0${from}.mp4`)
    makeClip(file, { seconds: 1, size: '64x36' })
    segments[from] = { from, to: from + 1, file, duration: 1 }
  }
  write(path.join(segDir, '_state.json'), { segments })
  const outDir = path.join(dir, 'frames')
  const r = runScript(dir, 'build-frames.mjs',
    ['--segments', segDir, '--storyboard', sbFile, '--out', outDir, '--per-clip', '3', '--width', '160'])

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /still the placeholder/)
  assert.match(r.stderr, /step 2/, 'it should name which step is unwritten')
  /* Refused before anything was touched. The loop rebuilds each clip directory by deleting it
     first, so a late refusal leaves a half-built tree while the old config.js still describes the
     tree that used to be there. */
  assert.equal(fs.existsSync(path.join(outDir, 'clip1')), false, 'nothing should have been built')
  assert.equal(fs.existsSync(path.join(outDir, 'config.js')), false)
})

test('build-frames is happy once the captions are written', { skip: FF.ok ? false : FF.why }, () => {
  const dir = stageScript('build-frames.mjs')
  const sb = storyboard(3)
  sb.captions = 'mine'
  sb.steps.forEach((s, i) => { s.caption = `A caption a human wrote, ${i + 1}.` })
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const segDir = path.join(dir, 'segments')
  const segments = {}
  for (const from of [1, 2]) {
    const file = path.join(segDir, `segment-0${from}.mp4`)
    makeClip(file, { seconds: 1, size: '64x36' })
    segments[from] = { from, to: from + 1, file, duration: 1 }
  }
  write(path.join(segDir, '_state.json'), { segments })
  const outDir = path.join(dir, 'frames')
  const r = runScript(dir, 'build-frames.mjs',
    ['--segments', segDir, '--storyboard', sbFile, '--out', outDir, '--per-clip', '3', '--width', '160'])

  assert.equal(r.status, 0, r.out)
  const cfg = fs.readFileSync(path.join(outDir, 'config.js'), 'utf8')
  assert.match(cfg, /A caption a human wrote/)
  assert.equal(cfg.includes(PLACEHOLDER), false)
})
