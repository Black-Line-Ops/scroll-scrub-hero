/* The seam check — the first thing in this repo that looks at the deliverable.

   Everything else is tested upstream of the artifact: the argument parser, the retry policy, the
   rate table. The failure that actually happens is a visible jump cut where two clips meet, and
   until now that was found by a human scrolling a page and squinting.

   The design point worth testing is not "does it compute SSIM". It is that an ABSOLUTE threshold
   would lie in both directions. Shingles, foliage, gravel and water shimmer between consecutive
   frames even on a locked camera, so detailed footage scores low everywhere and every join trips;
   flat footage scores high everywhere and a real cut can sit above the line. So the baseline comes
   from ordinary frame-to-frame steps INSIDE the clips, where by construction there is no seam, and
   a join is judged as a ratio against that.

   Both directions are asserted below with real ffmpeg on real files, because a check that only
   ever says "ok" is worse than no check: it is a green light nobody earned. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, tmpDir, runScript, ff, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()

/* Build a frame tree by hand. `noisy` swaps in a different pattern so the WITHIN-clip baseline is
   genuinely low, which is the case an absolute threshold gets wrong. */
function tree ({ clips = 3, framesPer = 6, cutBefore = null, noisy = false } = {}) {
  const dir = tmpDir('ssh-seams-')
  const frames = path.join(dir, 'frames')
  for (let c = 1; c <= clips; c++) {
    const cd = path.join(frames, `clip${c}`)
    fs.mkdirSync(cd, { recursive: true })
    /* Everything after the planted cut comes from a different source, so exactly one join is bad
       and every other join and every within-clip step stays normal. */
    const src = (cutBefore !== null && c >= cutBefore) ? 'testsrc2' : 'testsrc'
    for (let i = 1; i <= framesPer; i++) {
      const drift = ((c - 1) * framesPer + (i - 1)) * (noisy ? 0.004 : 0.008)
      ff(['-f', 'lavfi', '-i', `${src}=size=160x90:rate=1:duration=1`, '-frames:v', '1',
        '-vf', `eq=brightness=${drift.toFixed(4)}`, path.join(cd, `frame-000${i}.webp`)])
    }
  }
  return { dir, frames }
}

function check (frames, argv = []) {
  const dir = stageScript('seams.mjs')
  return runScript(dir, 'seams.mjs', ['--frames', frames, ...argv])
}

test('a clean chain reports every join as ok', { skip: FF.ok ? false : FF.why }, () => {
  const { frames } = tree({ clips: 3 })
  const r = check(frames)

  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /3 clips, 2 joins/)
  assert.match(r.stdout, /baseline\s+0\.\d+ SSIM/)
  assert.equal(r.stdout.includes('LIKELY A VISIBLE CUT'), false, 'a clean chain must not be flagged')
  /* The honest caveat has to survive a clean result, or the check overclaims: it measures pixels,
     and a seam can match closely and still read wrong because the light moved. */
  assert.match(r.stdout, /measures pixels, not composition/)
})

test('a planted jump cut is found, and only that join', { skip: FF.ok ? false : FF.why }, () => {
  const { frames } = tree({ clips: 4, cutBefore: 4 })
  const r = check(frames)

  assert.equal(r.status, 0, r.out, 'without --strict this reports rather than fails')
  const cuts = (r.stdout.match(/LIKELY A VISIBLE CUT/g) || []).length
  assert.equal(cuts, 1, `expected exactly one bad join, saw ${cuts}`)
  assert.match(r.stdout, /clip3 -> clip4/)
  /* The whole value of finding it is being told what to do about it, in a command that can be
     pasted. A report that says "seam 3 is bad" and stops has moved the problem, not solved it. */
  assert.match(r.stdout, /--only 3/)
  assert.match(r.stdout, /tween\.mjs/)
})

test('--strict turns the report into a gate', { skip: FF.ok ? false : FF.why }, () => {
  const bad = tree({ clips: 4, cutBefore: 4 })
  assert.equal(check(bad.frames, ['--strict']).status, 1, 'a cut should fail under --strict')

  const good = tree({ clips: 3 })
  assert.equal(check(good.frames, ['--strict']).status, 0, 'a clean chain should pass under --strict')
})

test('the baseline comes from the footage, so busy material is not flagged wholesale',
  { skip: FF.ok ? false : FF.why }, () => {
    /* The reason an absolute threshold was rejected. This tree has no planted cut, but its
       within-clip movement is different from the previous test's - a fixed cutoff would have to be
       right for both, and there is no such number. The ratio is scale-free, so both pass. */
    const { frames } = tree({ clips: 3, noisy: true })
    const r = check(frames)

    assert.equal(r.status, 0, r.out)
    assert.equal(r.stdout.includes('LIKELY A VISIBLE CUT'), false,
      'busy footage with no cut must not be flagged - that is what a fixed threshold gets wrong')
  })

test('one clip is not a seam, and says so instead of dividing by nothing',
  { skip: FF.ok ? false : FF.why }, () => {
    const { frames } = tree({ clips: 1 })
    const r = check(frames)

    assert.equal(r.status, 0, r.out)
    assert.match(r.stdout, /a seam needs two/)
  })

test('a directory with no frames fails loudly rather than reporting all-clear',
  { skip: FF.ok ? false : FF.why }, () => {
    /* The worst possible outcome for a checker: measuring nothing and printing a clean bill. */
    const dir = tmpDir('ssh-seams-empty-')
    const frames = path.join(dir, 'frames')
    fs.mkdirSync(path.join(frames, 'clip1'), { recursive: true })
    fs.mkdirSync(path.join(frames, 'clip2'), { recursive: true })
    const r = check(frames)

    assert.equal(r.status, 1, r.out)
    assert.equal(r.stdout.includes('ok'), false, 'nothing was measured, so nothing is ok')
  })
