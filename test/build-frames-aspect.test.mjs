/* build-frames.mjs used to have no concept of frame shape at all. `scale=${width}:-2` is correct
   arithmetic - the height follows the source - and it is silent about everything that matters once
   a run can produce more than one frame set.

   Two failures come out of that silence, and neither of them is an error:

     A portrait build at the old flat `--width 1600` default emits 1600x2844 frames. Four times the
     pixels of the desktop set, for a viewport around 390 CSS px wide. Nothing fails; the budget
     line at the end just says a number nobody can explain.

     A mobile build pointed at the desktop segments - one stale --segments path, the easiest
     mistake to make once there are two runs in play - produces a config that loads, a page that
     renders, and a hero that is quietly the wrong shape.

   So the shape is read off the pixels (the segments are finished files by then; anything else
   would be a claim about them rather than a reading of them), --aspect is checked against that
   reading rather than used in place of it, and the answer is written into config.js because the
   page needs the box sized before the first frame has decoded. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()

/* Every assertion here is about real pixels, so unlike the guard tests there is no placeholder
   path: without ffmpeg there is nothing to read a shape from and the test would be asserting
   against its own stub. */
function scene ({ size = '64x36', argv = [] } = {}) {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(3))
  const segments = {}
  for (const from of [1, 2]) {
    const file = path.join(segDir, `segment-0${from}.mp4`)
    makeClip(file, { seconds: 1, pattern: from % 2 ? 'testsrc' : 'testsrc2', size })
    segments[from] = { from, to: from + 1, file, duration: 1 }
  }
  write(path.join(segDir, '_state.json'), { segments })
  const outDir = path.join(dir, 'frames')
  const r = runScript(dir, 'build-frames.mjs',
    ['--segments', segDir, '--storyboard', sbFile, '--out', outDir, '--per-clip', '4', ...argv])
  const cfgFile = path.join(outDir, 'config.js')
  return { ...r, outDir, cfg: fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null }
}

test('the frame shape is read off the footage and written into config.js', { skip: FF.ok ? false : FF.why }, () => {
  const r = scene({ size: '64x36', argv: ['--width', '160'] })

  assert.equal(r.status, 0, r.out)
  /* The page has to reserve the scrub container before it has fetched a frame, or the hero pops
     into place after load. This line is the only thing that lets it. */
  assert.match(r.cfg, /window\.HERO_ASPECT="16:9"/)
  assert.match(r.cfg, /window\.HERO_SEQ=\[/)
})

test('portrait footage is recognised, and does not inherit the landscape width default', { skip: FF.ok ? false : FF.why }, () => {
  const r = scene({ size: '36x64' })

  assert.equal(r.status, 0, r.out)
  assert.match(r.cfg, /window\.HERO_ASPECT="9:16"/)
  /* 900, not 1600. The old default was a landscape number applied to everything, and at 9:16 it
     quadrupled the byte cost of the set that is served to the smallest screens. */
  assert.match(r.stdout, /900px wide frames/)
  assert.match(r.stdout, /portrait default/)
})

test('an explicit --width still wins on portrait footage', { skip: FF.ok ? false : FF.why }, () => {
  const r = scene({ size: '36x64', argv: ['--width', '1200'] })

  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /1200px wide frames/)
  assert.equal(r.stdout.includes('portrait default'), false, 'a flag the user typed is not a default')
})

test('--aspect that disagrees with the footage stops the build before anything is encoded', { skip: FF.ok ? false : FF.why }, () => {
  const r = scene({ size: '64x36', argv: ['--aspect', '9:16'] })

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /--aspect 9:16 was asked for/)
  assert.match(r.stderr, /wrong segments/)
  /* The point of catching it here rather than on the page: no ffmpeg time was spent, and no
     half-built frame tree was left for the next run to diff against. */
  assert.equal(fs.existsSync(path.join(r.outDir, 'clip1')), false, 'nothing should have been cut')
  assert.equal(r.cfg, null)
})

test('--aspect that agrees with the footage is simply allowed through', { skip: FF.ok ? false : FF.why }, () => {
  const r = scene({ size: '36x64', argv: ['--aspect', '9:16', '--width', '180'] })

  assert.equal(r.status, 0, r.out)
  assert.match(r.cfg, /window\.HERO_ASPECT="9:16"/)
})

test('a --width that is a number but useless is refused', { skip: FF.ok ? false : FF.why }, () => {
  /* Not a duplicate of the parser's check. kie.mjs already refuses `--width wide`; what it cannot
     know is that 8 is a legal number and a useless frame width. Both directions are covered, so
     neither guard can be removed on the assumption the other has it. */
  const nonsense = scene({ argv: ['--width', 'wide'] })
  assert.equal(nonsense.status, 1, nonsense.out)
  assert.match(nonsense.stderr, /--width must be a number/)

  const tiny = scene({ argv: ['--width', '8'] })
  assert.equal(tiny.status, 1, tiny.out)
  assert.match(tiny.stderr, /too small to build a hero from/)
})
