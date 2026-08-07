/* CRITICAL-1, reproduced. build-frames.mjs used to name clip directories positionally while
   looking captions up by the segment's own `to` step. Delete one segment and the two silently
   desynchronise: the paving stage vanishes, stage 5 gets labelled "03 · Clear Water", and every
   signal - exit code, summary, config.js - reads success. A paid hero shipped a chapter short.

   sb.motions is the only record of how many segments SHOULD exist, and nothing consulted it.

   So there are two assertions here, and they are different assertions:
     1. a storyboard motion with no video is a FAILURE, not a renumbering
     2. --allow-gaps builds anyway, deliberately, and the surviving clips keep the numbers their
        motions gave them - clip1 and clip3, with no clip2 - rather than sliding up to fill the
        hole. Exiting non-zero would be easy; keeping the numbering honest is the actual fix. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()

/* Four steps, three motions (1->2, 2->3, 3->4). `have` lists which motions actually rendered. */
function scene (have, { realClips = false } = {}) {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sb = storyboard(4)
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)

  const segments = {}
  for (const from of have) {
    const file = path.join(segDir, `segment-${String(from).padStart(2, '0')}.mp4`)
    if (realClips) makeClip(file, { seconds: 1, pattern: from % 2 ? 'testsrc' : 'testsrc2' })
    else write(file, `not a real video - the gap check runs before anything reads this`)
    segments[from] = { from, to: from + 1, file, duration: 1 }
  }
  write(path.join(segDir, '_state.json'), { segments })

  return { dir, segDir, sbFile, outDir: path.join(dir, 'frames') }
}

const build = (s, extra = []) => runScript(s.dir, 'build-frames.mjs',
  ['--segments', s.segDir, '--storyboard', s.sbFile, '--out', s.outDir, '--width', '160', ...extra])

test('a storyboard motion with no video stops the build', () => {
  const s = scene([1, 3])                       /* motion 2->3 never rendered */
  const r = build(s)

  assert.equal(r.status, 1, `a missing chapter must not exit 0:\n${r.out}`)
  assert.match(r.stderr, /1 of 3 segment\(s\) described by .*storyboard\.json have no video/)
  assert.match(r.stderr, /^\s*2->3\s*$/m, 'the message has to name which chapter is missing')
  assert.match(r.stderr, /would ship a hero with those chapters missing, at exit 0/)
  /* A remedy the reader can paste. The whole failure mode was that nobody knew anything was
     wrong, so the error owes them the next command. */
  assert.match(r.stderr, /node tween\.mjs --storyboard .* --only 2/)
  assert.match(r.stderr, /--allow-gaps/)

  assert.equal(fs.existsSync(path.join(s.outDir, 'config.js')), false,
    'nothing may be written when the build is refused - a stale config is what ships')
})

test('every motion missing is still an error, not an empty success', () => {
  /* The state file records segments, so `no completed segments` does not fire; the storyboard
     cross-check is the only thing standing between this and a hero with no chapters. */
  const s = scene([9])                          /* one stray segment, none of the real motions */
  const r = build(s)

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /3 of 3 segment\(s\) described by .* have no video/)
})

test('a storyboard with no motions at all says so rather than pretending to check', () => {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sb = storyboard(2)
  delete sb.motions
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const file = write(path.join(segDir, 'segment-01.mp4'), 'placeholder')
  write(path.join(segDir, '_state.json'), { segments: { 1: { from: 1, to: 2, file, duration: 1 } } })

  const r = runScript(dir, 'build-frames.mjs',
    ['--segments', segDir, '--storyboard', sbFile, '--out', path.join(dir, 'frames'), '--width', '160'])

  assert.match(r.out, /lists no motions, so nothing can be cross-checked/)
})

test('a recorded segment whose file has vanished is reported, not filtered out in silence', () => {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(3))
  write(path.join(segDir, '_state.json'), {
    segments: {
      1: { from: 1, to: 2, file: path.join(segDir, 'segment-01.mp4'), duration: 1 },
      2: { from: 2, to: 3, file: path.join(segDir, 'segment-02.mp4'), duration: 1 },
    },
  })
  write(path.join(segDir, 'segment-01.mp4'), 'placeholder')   /* segment-02 is deliberately absent */

  const r = runScript(dir, 'build-frames.mjs',
    ['--segments', segDir, '--storyboard', sbFile, '--out', path.join(dir, 'frames'), '--width', '160'])

  assert.match(r.out, /segment 2->3 is recorded as generated but segment-02\.mp4 is not in/)
  assert.equal(r.status, 1, 'and it is still a gap, so the build stops')
})

test('--allow-gaps builds the hole deliberately and keeps the numbering honest', (t) => {
  if (!FF.ok) {
    t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`)
    return
  }
  const s = scene([1, 3], { realClips: true })
  const r = build(s, ['--allow-gaps', '--per-clip', '8'])

  assert.equal(r.status, 0, `--allow-gaps should permit the build:\n${r.out}`)
  assert.match(r.stderr, /--allow-gaps was given, so building without them/)
  assert.match(r.stderr, /The hero will have a hole here/)

  /* The heart of CRITICAL-1. The second surviving clip is motion 3->4, so it is chapter 3.
     Renumbering it to clip2 is what silently slid every later caption one chapter out of place. */
  const dirs = fs.readdirSync(s.outDir).filter(f => f.startsWith('clip')).sort()
  assert.deepEqual(dirs, ['clip1', 'clip3'], 'the missing chapter must leave a hole, not close up')

  const cfg = fs.readFileSync(path.join(s.outDir, 'config.js'), 'utf8')
  /* Caption and folder are now derived from the same number, so they cannot drift apart. */
  assert.match(cfg, /"dir":"clip1","n":8,"k":"01 · Stage 2"/)
  assert.match(cfg, /"dir":"clip3","n":8,"k":"03 · Stage 4"/)
  assert.equal(cfg.includes('clip2'), false, 'nothing should have been renumbered into the hole')
  assert.match(cfg, /^window\.HERO_EXT="webp";$/m)
  assert.match(cfg, /^window\.HERO_SEQ=\[$/m)
})

test('a complete storyboard builds every chapter with no complaint', (t) => {
  if (!FF.ok) {
    t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`)
    return
  }
  /* The positive control. Without it, "stops the build" is satisfiable by a script that always
     stops - and a spend gate that never opens is its own kind of broken. */
  const s = scene([1, 2, 3], { realClips: true })
  const r = build(s, ['--per-clip', '8'])

  assert.equal(r.status, 0, r.out)
  assert.doesNotMatch(r.out, /have no video/)
  assert.deepEqual(fs.readdirSync(s.outDir).filter(f => f.startsWith('clip')).sort(),
    ['clip1', 'clip2', 'clip3'])

  const cfg = fs.readFileSync(path.join(s.outDir, 'config.js'), 'utf8')
  for (const [clip, stage] of [[1, 2], [2, 3], [3, 4]]) {
    assert.match(cfg, new RegExp(`"dir":"clip${clip}","n":8,"k":"0${clip} · Stage ${stage}"`),
      `clip${clip} should caption from step ${stage}`)
  }
})

test('--var is rejected at the sink as well as at the parser', () => {
  /* The parser checks it, but a default, a config read or a direct call never passes through the
     parser - and this value is interpolated straight into generated JavaScript source. */
  const s = scene([1, 2, 3])
  const r = build(s, ['--var=HERO'])
  assert.notEqual(r.status, 0)        /* the placeholder clips are not real video; that is fine */
  assert.doesNotMatch(r.out, /--var must be/, 'a valid identifier must get through')

  /* And an invalid one dies before ffmpeg is ever reached. */
  const bad = runScript(s.dir, 'build-frames.mjs',
    ['--segments', s.segDir, '--storyboard', s.sbFile, '--out', s.outDir, '--var=hero-scroll'])
  assert.equal(bad.status, 1)
  assert.match(bad.out, /--var must be a JavaScript identifier/)
})
