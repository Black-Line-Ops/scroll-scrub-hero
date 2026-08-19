/* --dry-run has exactly one promise: it shows you the plan and charges nothing.

   A flag like this is only worth having if it cannot be argued out of that promise, and the
   argument that would come up in practice is `--yes`. Every documented invocation of keyframes.mjs
   and tween.mjs for an agent carries --yes, because without it the run blocks on a prompt nobody is
   there to answer. So the realistic way to reach a dry run is to add --dry-run to a line that
   already has --yes on it, and if --yes won that argument the flag would spend money on the exact
   command people actually type.

   The staged kie client throws on every paid call, so "did not spend" is not asserted by reading
   output - it is the difference between exit 0 and a BILLABLE error. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()

test('storyboard.mjs --dry-run quotes the run and never asks Sol', () => {
  const dir = stageScript('storyboard.mjs', { also: ['pricing.mjs'] })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare yard to finished pool', '--steps', '6', '--out', out, '--dry-run'])

  assert.equal(r.status, 0, r.out)
  /* The forecast IS the output. A dry run that skipped it would print nothing worth reading. */
  assert.match(r.stdout, /forecast for the whole run/)
  assert.match(r.stdout, /nothing was sent and nothing was charged/)
  assert.equal(fs.existsSync(path.join(dir, 'sol-call.json')), false, 'Sol was billed on a dry run')
  assert.equal(fs.existsSync(out), false, 'a dry run must not write the storyboard')
  /* Not cosmetic. On Windows, process.exit() after a fetch trips a libuv assertion that prints
     below the summary and replaces the exit code with 127 - the same bug doctor.mjs sidesteps by
     setting process.exitCode. This gate exits, so a balance lookup above it turns every
     successful dry run on Windows into an assertion dump. Reproduced on Node 24.15.0. */
  assert.match(r.stdout, /balance not checked on a dry run/)
  assert.equal(r.stdout.includes('balance unknown'), false, 'the balance was fetched anyway')
})

test('storyboard.mjs --dry-run does not draw the seed frame either', () => {
  /* The seed is the first line item that costs real money on a run with no photo. If the dry-run
     gate sat below it, `--idea ... --dry-run` would render an image and then announce that nothing
     had been charged. */
  const dir = stageScript('storyboard.mjs', { solText: 'unused', image: 'png', also: ['pricing.mjs'] })
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--idea', 'empty lot to finished house', '--steps', '6', '--out', out, '--dry-run'])

  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /opening frame  generated/)
  assert.match(r.stdout, /seeded from the idea/)
  assert.equal(fs.existsSync(path.join(dir, 'image-calls.json')), false, 'the seed was rendered on a dry run')
  assert.equal(fs.existsSync(path.join(dir, 'sol-call.json')), false)
  assert.equal(fs.existsSync(out.replace(/\.json$/i, '') + '.seed.png'), false)
})

test('keyframes.mjs --dry-run prints the prompts and generates nothing, even with --yes', () => {
  const dir = stageScript('keyframes.mjs', { also: ['pricing.mjs'] })
  const sb = storyboard(4)
  sb._meta = { ref: write(path.join(dir, 'yard.jpg'), 'placeholder'), seeded: false }
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const outDir = path.join(dir, 'keyframes')
  const r = runScript(dir, 'keyframes.mjs', ['--storyboard', sbFile, '--out', outDir, '--yes', '--dry-run'])

  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /the prompts that would be sent/)
  /* Every step, not a sample. A dry run that showed the first prompt would hide the one that is
     usually wrong - the last, where the finished state is described. */
  for (const s of sb.steps) assert.match(r.stdout, new RegExp(`keyframe ${s.id} - ${s.label}`))
  assert.equal(fs.existsSync(path.join(outDir, 'keyframe-01.png')), false)
})

test('tween.mjs --dry-run prints the motion prompts and orders no video, even with --yes',
  { skip: FF.ok ? false : FF.why }, () => {
    const dir = stageScript('tween.mjs', { also: ['pricing.mjs'] })
    const sb = storyboard(3)
    const sbFile = write(path.join(dir, 'storyboard.json'), sb)
    /* tween reads the keyframe state for its first/last frames, so those files have to exist or the
       run stops for a reason that has nothing to do with --dry-run. */
    const kfDir = path.join(dir, 'keyframes')
    const frames = {}
    for (const s of sb.steps) {
      const file = path.join(kfDir, `keyframe-0${s.id}.png`)
      write(file, 'placeholder')
      frames[s.id] = { file, url: 'https://example.invalid/uploads/fake/kf' + s.id, uploadedAt: Date.now() }
    }
    write(path.join(kfDir, '_state.json'), { frames })
    const outDir = path.join(dir, 'segments')
    const r = runScript(dir, 'tween.mjs',
      ['--storyboard', sbFile, '--keyframes', kfDir, '--out', outDir, '--yes', '--dry-run'])

    assert.equal(r.status, 0, r.out)
    assert.match(r.stdout, /the motion prompts that would be sent/)
    for (const m of sb.motions) assert.match(r.stdout, new RegExp(`segment ${m.from} -> ${m.to}`))
    assert.equal(fs.existsSync(path.join(outDir, 'segment-01.mp4')), false)
  })

test('--dry-run is a boolean everywhere, so it never swallows the flag after it', () => {
  /* kie.mjs refuses a valueless flag unless it is in BOOLEAN_FLAGS, and it is shared: registering
     --dry-run in three places separately is how one of them ends up missing it and dying with
     "--dry-run needs a value" on a command that is completely correct. */
  const dir = stageScript('storyboard.mjs', { also: ['pricing.mjs'] })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  for (const argv of [
    ['--dry-run', '--ref', ref, '--idea', 'bare yard to pool', '--out', out],
    ['--ref', ref, '--idea', 'bare yard to pool', '--out', out, '--dry-run'],
  ]) {
    const r = runScript(dir, 'storyboard.mjs', argv)
    assert.equal(r.status, 0, r.out)
    assert.match(r.stdout, /nothing was sent and nothing was charged/)
  }
})
