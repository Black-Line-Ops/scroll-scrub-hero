/* build-frames.mjs refuses a storyboard with no steps BEFORE it cuts anything.

   The caption lookup at the bottom of the clip loop indexes sb.steps, and nothing checked the key
   was there. Measured with a storyboard carrying motions but no steps: the script cut clip1's
   frames in full, then died inside the loop on `sb.steps.find` with a raw
   `TypeError: Cannot read properties of undefined (reading 'find')` and a stack trace naming
   neither the storyboard nor the problem. Every clip before the crash is ffmpeg time already spent
   on a storyboard that could never have finished, and because a throw is not abort(), the clip
   directory it was holding was left on disk for the next run to diff against.

   The empty-array case is worse and it is the one to keep in mind when reading these assertions:
   `[].find(...)` does not throw. It returns undefined, `|| {}` swallows it, and the build runs to
   completion at exit 0 with every chapter captioned "Step 1", "Step 2" - a paid deliverable with
   the labels quietly replaced by placeholders. So `steps: []` is asserted as a REFUSAL, not merely
   as "does not crash": a test that only checked for the TypeError would pass against that.

   keyframes.mjs:39-42 turns the same storyboard away for the same reason; the two must agree. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()

/* Real clips where ffmpeg is available, so "it did not do the ffmpeg work" is a claim about actual
   frames that would otherwise be on disk. Where it is not, placeholders are enough: the guard sits
   above every line that reads a segment, so the run must still stop before --out is even created.
   Either way the storyboard describes both motions and both have video, so the gap check is not
   what stops this - the steps guard is. */
function scene (steps) {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sb = storyboard(3)
  if (steps === undefined) delete sb.steps
  else sb.steps = steps
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)

  const segments = {}
  for (const from of [1, 2]) {
    const file = path.join(segDir, `segment-0${from}.mp4`)
    if (FF.ok) makeClip(file, { seconds: 1, pattern: from % 2 ? 'testsrc' : 'testsrc2' })
    else write(file, 'placeholder - the steps guard runs before anything reads this')
    segments[from] = { from, to: from + 1, file, duration: 1 }
  }
  write(path.join(segDir, '_state.json'), { segments })

  const outDir = path.join(dir, 'frames')
  return {
    outDir,
    sbFile,
    run: () => runScript(dir, 'build-frames.mjs',
      ['--segments', segDir, '--storyboard', sbFile, '--out', outDir, '--width', '160', '--per-clip', '8']),
  }
}

/* Nothing at all under --out. The guard sits above `fs.mkdirSync(outDir)`, so the directory should
   not even exist - which is a stronger and simpler statement than counting frames. */
function assertNothingBuilt (s, r) {
  assert.equal(fs.existsSync(s.outDir), false,
    `the refusal has to come before any work: ${s.outDir} exists, holding ` +
    `${fs.existsSync(s.outDir) ? fs.readdirSync(s.outDir).join(', ') : ''}`)
  assert.doesNotMatch(r.stdout, /^clip\d+ {2}<-/m,
    'no clip may be announced, let alone cut, from a storyboard that can never be captioned')
}

for (const [name, steps] of [['no steps key at all', undefined], ['an empty steps array', []]]) {
  test(`a storyboard with motions and ${name} is refused before any clip is cut`, () => {
    const s = scene(steps)
    const r = s.run()

    assert.equal(r.status, 1, `this storyboard can never produce a captioned hero:\n${r.out}`)

    /* Named error, naming the file and the problem. The whole complaint about the old behaviour
       was that the stack trace mentioned neither. */
    assert.match(r.stderr, /storyboard\.json has no steps, so no clip can be captioned/,
      'the error has to name the storyboard and say what is wrong with it')
    assert.match(r.stderr, /steps must be a non-empty array/,
      'and say what a correct one looks like')

    /* The raw failure this replaced. Asserted separately from the message above because a guard
       that prints the right sentence and then falls through into the loop anyway would satisfy
       one and not the other. */
    assert.doesNotMatch(r.out, /Cannot read properties of undefined/)
    assert.doesNotMatch(r.out, /TypeError/)
    assert.doesNotMatch(r.out, /at Object\.<anonymous>/, 'a stack trace is not an error message')

    assertNothingBuilt(s, r)
  })
}

test('the refusal is about steps, not about the segments or the motions', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to prove the same tree builds - ${FF.why}`); return }

  /* The positive control. Same segments, same motions, same everything - only sb.steps restored.
     Without this, "refuses a storyboard with no steps" is satisfiable by a build-frames.mjs that
     refuses every storyboard, and the guard would be indistinguishable from an outage. */
  const s = scene(storyboard(3).steps)
  const r = s.run()

  assert.equal(r.status, 0, `the identical tree with steps present must build:\n${r.out}`)
  assert.deepEqual(fs.readdirSync(s.outDir).filter(f => f.startsWith('clip')).sort(), ['clip1', 'clip2'])

  const cfg = fs.readFileSync(path.join(s.outDir, 'config.js'), 'utf8')
  /* And the captions really do come from sb.steps, which is what the guard is protecting. An
     empty steps array would have written "Step 1"/"Step 2" here and exited 0. */
  assert.match(cfg, /"k":"01 · Stage 2"/)
  assert.match(cfg, /"k":"02 · Stage 3"/)
  assert.equal(cfg.includes('"k":"01 · Step 1"'), false,
    'placeholder captions mean the label lookup silently found nothing')
})
