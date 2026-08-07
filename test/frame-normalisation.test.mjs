/* Frame-count normalisation in build-frames.mjs, which has one correct half and one half that
   shipped a broken deliverable at exit 0.

   The DROP is correct and must stay. fps sampling can land one frame over, and that extra frame
   only ever appears at t=duration - which is the destination keyframe, byte-identical to the next
   clip's frame 1. Keeping it holds the seam for a frame; dropping it is what prevents the stall.
   The regression to guard against is someone "fixing" it into a leading drop, which would throw
   away the frame that joins this clip to the previous one.

   The PAD was unbounded. A truncated clip with 16 real frames was topped up to 40 by repeating
   the last one 25 times - a chapter frozen for 62% of its scroll, reported as a clean 40, exit 0.
   A shortfall past a tenth of the clip is a broken file, not a rounding artefact.

   These drive real ffmpeg, because the thing under test is how the script reacts to the number of
   files ffmpeg actually wrote. Frame counts are steered with a raw H.264 elementary stream:
   ffprobe reports no container duration for one, so build-frames falls back to the duration
   recorded in the segment state - which the test controls. Lying about the duration is exactly
   what a truncated download does, so this is the real failure, not an approximation of it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()
const PER_CLIP = 40

/* One segment, one motion. `seconds` is how much video really exists; `claims` is what the state
   file says its duration is. build-frames computes fps = per-clip / claims and applies it to
   `seconds` of footage, so the pair chooses the frame count exactly. */
function oneClip ({ seconds, claims }) {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(2))
  const file = path.join(segDir, 'segment-01.h264')
  makeClip(file, { seconds, raw: true })
  write(path.join(segDir, '_state.json'), { segments: { 1: { from: 1, to: 2, file, duration: claims } } })
  const outDir = path.join(dir, 'frames')
  return {
    outDir,
    run: (extra = []) => runScript(dir, 'build-frames.mjs',
      ['--segments', segDir, '--storyboard', sbFile, '--out', outDir,
        '--width', '160', '--per-clip', String(PER_CLIP), ...extra]),
  }
}

const frames = (dir) => fs.readdirSync(dir).filter(f => f.endsWith('.webp')).sort()

test('surplus frames are dropped from the END, never the start', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  /* 2s of footage described as 1s, so the sampler runs at double rate and writes 80 frames for a
     40-frame clip. Overshooting by 40 rather than by 1 does not change the mechanism - the same
     `while (files.length > perClip) files.pop()` runs - and it makes the direction of the drop
     unambiguous, which is the property worth locking. */
  const c = oneClip({ seconds: 2, claims: 1 })
  const r = c.run()
  assert.equal(r.status, 0, r.out)

  const kept = frames(path.join(c.outDir, 'clip1'))
  assert.equal(kept.length, PER_CLIP, 'the clip must contain exactly --per-clip frames')
  /* frame-0001..frame-0040 and nothing above it. A leading drop would leave 0041..0080 here. */
  assert.deepEqual(kept, Array.from({ length: PER_CLIP }, (_, i) => `frame-${String(i + 1).padStart(4, '0')}.webp`),
    'the surviving frames must be the FIRST forty; dropping from the front would break the seam ' +
    'with the previous clip, which is the one frame that has to match')
  assert.equal(fs.existsSync(path.join(c.outDir, 'clip1', 'frame-0041.webp')), false,
    'the dropped frames have to leave the disk too - config.js and the folder must agree exactly')

  const cfg = fs.readFileSync(path.join(c.outDir, 'config.js'), 'utf8')
  assert.match(cfg, new RegExp(`"n":${PER_CLIP}`), 'config.js must report what is actually on disk')
})

test('a badly under-length clip is refused instead of padded', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  /* 1s of footage described as 10s: the container advertises ten times the video it holds, which
     is what a truncated or partly-downloaded segment looks like. Four frames arrive for a
     40-frame clip. The old loop repeated frame 4 thirty-six times and exited 0. */
  const c = oneClip({ seconds: 1, claims: 10 })
  const r = c.run()

  assert.equal(r.status, 1, `a 90%-frozen chapter must not exit 0:\n${r.out}`)
  assert.match(r.stderr, /clip1 produced only 4 of 40 frames from a 10\.00s segment/)
  assert.match(r.stderr, /probably truncated/)
  assert.match(r.stderr, /freeze this chapter for 90% of its scroll/)
  assert.match(r.stderr, /lower --per-clip to what the footage supports/)

  assert.doesNotMatch(r.stdout, /repeating the last one/, 'it must not pad and then complain')
  assert.equal(fs.existsSync(path.join(c.outDir, 'config.js')), false,
    'no config.js, or the next deploy ships the frozen chapter anyway')
})

test('a small shortfall is still padded, and says so out loud', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  /* The pad is a normalisation, not a bug - the page indexes frames by number, so a clip one or
     two short is a broken scrub. Only the UNBOUNDED version was the defect. Removing the pad
     entirely would be the other way to break this, so it is asserted in both directions. */
  const c = oneClip({ seconds: 1, claims: 40 / 38 })     /* fps 38 over 1s of footage -> 38 frames */
  const r = c.run()
  assert.equal(r.status, 0, r.out)

  const produced = Number(r.stdout.match(/only (\d+) of 40 frames/)?.[1])
  assert.ok(Number.isInteger(produced), `expected a shortfall notice in:\n${r.stdout}`)
  assert.ok(produced >= Math.ceil(PER_CLIP * 0.9) && produced < PER_CLIP,
    `this fixture should land inside the tolerated band, got ${produced}`)
  assert.match(r.stdout, new RegExp(`repeating the last one ${PER_CLIP - produced}× to fill the clip`))

  const kept = frames(path.join(c.outDir, 'clip1'))
  assert.equal(kept.length, PER_CLIP, 'the pad must reach exactly --per-clip, never past it')

  /* The padding is copies of the LAST real frame, so the clip ends where the footage ended. */
  const last = fs.readFileSync(path.join(c.outDir, 'clip1', kept[kept.length - 1]))
  const lastReal = fs.readFileSync(path.join(c.outDir, 'clip1', kept[produced - 1]))
  assert.ok(last.equals(lastReal), 'the pad must repeat the final real frame')
})

test('a clip with no usable duration anywhere is refused, not sampled at NaN fps', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  /* ffprobe prints the STRING "N/A" for a container that carries no duration, and "N/A" is
     truthy, so the fallback written for exactly this case never ran: fps became "NaN" and
     ffmpeg's rejection of `-vf fps=NaN` arrived with its stderr swallowed. Guessing a duration
     for a file whose real one is unknown just samples the wrong part of it. */
  const c = oneClip({ seconds: 1, claims: 0 })      /* raw stream: no container duration either */
  const r = c.run()

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /reports no usable duration/)
  assert.doesNotMatch(r.out, /fps=NaN/)
  assert.equal(fs.existsSync(path.join(c.outDir, 'config.js')), false)
})
