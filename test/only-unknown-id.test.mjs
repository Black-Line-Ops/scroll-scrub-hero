/* `--only` with an id the storyboard does not have, in keyframes.mjs and tween.mjs.

   The defect was a DIVERGENCE. tween.mjs refused an unknown segment id from the start; keyframes
   .mjs did not, so `--only 99` filtered its list down to nothing, fell into the all-cached branch
   and printed "nothing to generate - all keyframes are cached" at exit 0. That is the opposite of
   the truth at the one moment it matters most: an operator has just typed a number to regenerate a
   frame they were unhappy with, and the script tells them the run is finished. They approve the
   contact sheet - which still shows the OLD frame - and authorise the expensive Kling stage.

   `--only 0` is the same hole reached by a different mistake: step ids are 1-based and array
   indices are not, so 0 is what someone types when they are counting from the wrong end.

   So there are three assertions here and the third is the one that keeps the fix honest:
     1. an unknown id is a stop, and the message names the bad id and lists the real ones
     2. a known id still gets through - a guard that refuses everything is its own regression
     3. the two scripts REJECT THE SAME SHAPE. Fixing keyframes.mjs to refuse `--only 99` with a
        different exit code, a different stream or a message that does not name the id would close
        this instance and leave the class open. The divergence was the bug; parity is the fix. */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { stageScript, runScript, write, storyboard } from './helpers/harness.mjs'

/* Four steps -> keyframe ids 1,2,3,4 and segments named by the step they start from: 1,2,3.
   `--only 3` is therefore valid for both scripts, and `--only 99` and `--only 0` for neither. */
const KEYFRAME_IDS = '1, 2, 3, 4'
const SEGMENT_IDS = '1, 2, 3'

const cached = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) =>
  [i + 1, { file: `/tmp/keyframe-0${i + 1}.png`, url: `https://example.invalid/kf${i + 1}.png` }]))

/* Every keyframe already on disk, so nothing on the accepted path can reach a paid call: the run
   stops at the spend gate, which confirm() declines because the child has no TTY. */
function keyframesRunner () {
  const dir = stageScript('keyframes.mjs')
  const outDir = path.join(dir, 'keyframes')
  const sbFile = write(path.join(dir, 'storyboard.json'),
    { ...storyboard(4), _meta: { ref: 'ref.jpg' } })
  write(path.join(outDir, '_state.json'), {
    refUrlRec: { url: 'https://example.invalid/ref.jpg', uploadedAt: Date.now() },
    frames: cached(4),
  })
  return (only) => runScript(dir, 'keyframes.mjs',
    ['--storyboard', sbFile, '--out', outDir, '--only', only])
}

function tweenRunner () {
  const dir = stageScript('tween.mjs')
  const kfDir = path.join(dir, 'keyframes')
  const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(4))
  write(path.join(kfDir, '_state.json'), { frames: cached(4) })
  return (only) => runScript(dir, 'tween.mjs',
    ['--storyboard', sbFile, '--keyframes', kfDir, '--out', path.join(dir, 'segments'), '--only', only])
}

const runKeyframes = keyframesRunner()
const runTween = tweenRunner()

for (const bad of ['99', '0']) {
  test(`keyframes.mjs --only ${bad} stops instead of reporting the run finished`, () => {
    const r = runKeyframes(bad)

    assert.equal(r.status, 1, `a mistyped id must be a stop, not a no-op:\n${r.out}`)
    assert.match(r.stderr, new RegExp(`^--only ${bad}: no such keyframe in .*storyboard\\.json\\.$`, 'm'),
      'the message has to name the id that was wrong')
    assert.match(r.stderr, new RegExp(`Keyframes are named by their step id: ${KEYFRAME_IDS}`),
      'and list the ids that would have worked, or the operator is left guessing')

    /* The precise lie the fix removed. This is the assertion that goes red if the guard is
       deleted: without it the filter empties the list and this is what gets printed, at exit 0. */
    assert.doesNotMatch(r.stdout, /all keyframes are cached/,
      'reporting the run complete is what let a stale contact sheet be approved and billed against')
    assert.doesNotMatch(r.stdout, /nothing to generate/)
  })

  test(`tween.mjs --only ${bad} stops the same way`, () => {
    const r = runTween(bad)

    assert.equal(r.status, 1, r.out)
    assert.match(r.stderr, new RegExp(`^--only ${bad}: no such segment in .*storyboard\\.json\\.$`, 'm'))
    assert.match(r.stderr, new RegExp(`Segments are named by the step they start from: ${SEGMENT_IDS}`))
    assert.doesNotMatch(r.stdout, /every segment already has a video on disk/)
  })

  test(`the two scripts reject --only ${bad} in the same shape`, () => {
    const k = runKeyframes(bad)
    const t = runTween(bad)

    /* Same exit code, same stream, same sentence structure, same follow-up. Anything an operator
       or a wrapper script could key on has to look the same from both, because the original
       defect was precisely that one of them behaved differently from the other. */
    assert.equal(k.status, t.status, 'both must exit with the same code for the same bad input')
    assert.equal(k.status, 1)

    for (const [name, r, noun] of [['keyframes.mjs', k, 'keyframe'], ['tween.mjs', t, 'segment']]) {
      assert.match(r.stderr, new RegExp(`^--only ${bad}: no such ${noun} in .*storyboard\\.json\\.$`, 'm'),
        `${name} must open with the same "--only <id>: no such <thing> in <file>." line`)
      assert.equal(r.stdout.trim(), '',
        `${name} must say nothing on stdout - a refusal split across two streams interleaves ` +
        'out of order the moment either one is piped')
      /* Two lines: the refusal, then the valid ids. Not more - a wall of text at a stop is how
         the one number the operator needs gets missed. */
      assert.equal(r.stderr.trim().split('\n').length, 2,
        `${name} should print the refusal and the list of valid ids, nothing else`)
    }
  })
}

test('an unknown id is still named when it is mixed in with valid ones', () => {
  /* `--only 3,99` is the realistic typo: the operator meant two frames and fat-fingered one. The
     three would be regenerated and the 99 silently ignored, which is the same lie in miniature. */
  const r = runKeyframes('3,99')

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /^--only 99: no such keyframe in .*storyboard\.json\.$/m,
    'only the unknown id should be named, not the whole list')
  assert.doesNotMatch(r.stderr, /--only 3,99: no such/)
})

test('a known --only id still gets through to the spend gate, in both scripts', () => {
  /* The positive control, and it is not optional: a guard that refuses every id would satisfy
     every assertion above while breaking the one workflow --only exists for. Both runs stop at
     confirm(), which declines because the child has no TTY - so this proves the id was ACCEPTED
     and the run reached the point of asking to spend, without spending. */
  const k = runKeyframes('3')
  const t = runTween('3')

  assert.doesNotMatch(k.stderr, /no such keyframe/, `--only 3 is a real step id:\n${k.out}`)
  assert.doesNotMatch(t.stderr, /no such segment/, `--only 3 is a real motion id:\n${t.out}`)

  assert.match(k.stdout, /About to generate 1 keyframe still\(s\)/)
  assert.match(k.stdout, /keyframes {3}3$/m, 'the cost line should name the frame that was asked for')
  assert.match(t.stdout, /About to generate 1 video segment\(s\)/)
  assert.match(t.stdout, /segments {2}3->4$/m)

  /* Same acceptance shape as well as the same rejection shape. */
  for (const [name, r] of [['keyframes.mjs', k], ['tween.mjs', t]]) {
    assert.equal(r.status, 1, `${name} should decline the un-answerable prompt rather than spend:\n${r.out}`)
    assert.match(r.stdout, /aborted - nothing generated, nothing charged/, name)
  }
})
