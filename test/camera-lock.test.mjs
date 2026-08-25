/* The camera lock, ENFORCED. The one rule everything descends from used to live at the end of
   each hand-written motion prompt - which is exactly what the silent .slice(0, 500) ate first
   on an overlong motion. Ported from the sibling flight pipeline: the pipeline appends the
   lock with budget priority (on an overlong prompt the MOTION gives way, never the lock), a
   trailing hand-written lock is stripped so the characters are not spent twice, and the
   truncation says so out loud. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()
const NEEDS_FF = { skip: FF.ok ? false : FF.why }

function stageTween ({ mutate } = {}) {
  const dir = stageScript('tween.mjs', { image: 'fake mp4 bytes', also: ['pricing.mjs'] })
  const sb = storyboard(3)
  if (mutate) mutate(sb)
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
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
    ['--storyboard', sbFile, '--keyframes', kfDir, '--out', outDir, '--yes'])
  return { ...r, dir }
}

const LOCK_TAIL = /Camera locked, no pan, no zoom, no cut\. No text, no signage, no captions\.$/

test('every segment prompt ends with the camera lock, inside the 500 cap', NEEDS_FF, () => {
  const r = stageTween()
  assert.equal(r.status, 0, r.out)
  const calls = JSON.parse(fs.readFileSync(path.join(r.dir, 'image-calls.json'), 'utf8'))
  assert.ok(calls.length >= 2, 'segments must have been submitted')
  for (const c of calls) {
    assert.match(c.input.prompt, LOCK_TAIL, 'the lock is appended by the pipeline, not trusted to the motion text')
    assert.ok(c.input.prompt.length <= 500, `Kling rejects prompts over 500, got ${c.input.prompt.length}`)
  }
})

test('a hand-written trailing lock is stripped, not doubled', NEEDS_FF, () => {
  const r = stageTween({ mutate: (sb) => { sb.motions[0].prompt += ' Camera locked, no pan or zoom.' } })
  assert.equal(r.status, 0, r.out)
  const calls = JSON.parse(fs.readFileSync(path.join(r.dir, 'image-calls.json'), 'utf8'))
  for (const c of calls) {
    const hits = (c.input.prompt.match(/Camera locked/g) || []).length
    assert.equal(hits, 1, 'the characters must not be spent twice: ' + c.input.prompt.slice(-120))
  }
})

test('on an overlong motion, the MOTION gives way - the lock survives whole, and it says so', NEEDS_FF, () => {
  const r = stageTween({ mutate: (sb) => { sb.motions[0].prompt = 'The soil lifts away in stages. '.repeat(25) } })
  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /will be cut to \d+ - the tail of this motion is being dropped/)
  const calls = JSON.parse(fs.readFileSync(path.join(r.dir, 'image-calls.json'), 'utf8'))
  const long = calls.find(c => c.input.prompt.length === 500)
  assert.ok(long, 'the overlong segment must land exactly on the cap')
  assert.match(long.input.prompt, LOCK_TAIL, 'the lock outranks the motion for the last bytes of budget')
})
