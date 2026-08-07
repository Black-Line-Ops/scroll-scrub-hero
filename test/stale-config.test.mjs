/* build-frames.mjs removes config.js BEFORE it touches the first clip directory.

   config.js is the only index the frame tree has: the page reads it and fetches exactly the frames
   it names. Every guard in build-frames.mjs stops the run rather than ship something wrong - but
   stopping is only half an answer, because the clip loop rebuilds each directory by DELETING it
   first. A run that dies partway has therefore already changed the frames the LAST run's config
   describes, and that config is still sitting on disk claiming they are there. An already-wired
   page 404s every frame past the shortfall.

   READ THIS BEFORE ADDING ANOTHER "no config.js" ASSERTION SOMEWHERE ELSE. There are two of them
   already, in frame-normalisation.test.mjs, and they do NOT cover this line: both run on a fresh
   staged tree where no config was ever written, so "config.js does not exist" is true before the
   script starts and stays true if the removal is deleted. They are worth having - they say a
   failed run must not WRITE one - but they cannot see this fix. The ordering below is the entire
   test: put a config on disk FIRST, then fail the run mid-loop, then look. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard, makeClip, ffmpegStatus } from './helpers/harness.mjs'

const FF = ffmpegStatus()
const PER_CLIP = 8

/* Three steps, two motions, two segments. segment-01 is a healthy 1s mp4 and always cuts cleanly.
   segment-02 exists as BOTH a healthy mp4 and a raw H.264 elementary stream: ffprobe reports no
   container duration for a raw stream, so build-frames falls back to the duration the state file
   records - which lets a run claim ten seconds of video over one second of footage without
   hand-corrupting anything. That is exactly what a truncated download looks like, and it fails
   inside the clip loop, after clip1 has already been rebuilt. */
function tree () {
  const dir = stageScript('build-frames.mjs')
  const segDir = path.join(dir, 'segments')
  const outDir = path.join(dir, 'frames')
  const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(3))

  const one = path.join(segDir, 'segment-01.mp4')
  const twoGood = path.join(segDir, 'segment-02.mp4')
  const twoRaw = path.join(segDir, 'segment-02.h264')
  makeClip(one, { seconds: 1, pattern: 'testsrc' })
  makeClip(twoGood, { seconds: 1, pattern: 'testsrc2' })
  makeClip(twoRaw, { seconds: 1, pattern: 'testsrc2', raw: true })

  const setState = (second) => write(path.join(segDir, '_state.json'), {
    segments: {
      1: { from: 1, to: 2, file: one, duration: 1 },
      2: { from: 2, to: 3, ...second },
    },
  })

  return {
    outDir,
    cfg: path.join(outDir, 'config.js'),
    healthy: () => setState({ file: twoGood, duration: 1 }),
    /* One second of footage described as ten. fps = 8/10 over 1s of video yields one frame for an
       eight-frame clip, so the shortfall guard fires - inside the loop, past the removal. */
    truncated: () => setState({ file: twoRaw, duration: 10 }),
    run: () => runScript(dir, 'build-frames.mjs',
      ['--segments', segDir, '--storyboard', sbFile, '--out', outDir, '--width', '160',
        '--per-clip', String(PER_CLIP)]),
  }
}

test('a run that dies mid-loop takes the PREVIOUS run\'s config.js with it', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  const s = tree()

  /* Run one: healthy, and it must write a real config. Without this half the test would be
     satisfied by a build-frames.mjs that never writes a config at all. */
  s.healthy()
  const first = s.run()
  assert.equal(first.status, 0, `the first run has to succeed or the rest of this proves nothing:\n${first.out}`)
  assert.equal(fs.existsSync(s.cfg), true, 'a healthy run must write config.js')
  const wrote = fs.readFileSync(s.cfg, 'utf8')
  assert.match(wrote, new RegExp(`"dir":"clip2","n":${PER_CLIP}`),
    'the first config must claim clip2 holds every frame, because that is the claim run two falsifies')

  /* Run two: the same tree, with segment 2 now a truncated download. */
  s.truncated()
  const second = s.run()

  assert.equal(second.status, 1, `the shortfall guard should stop this run:\n${second.out}`)
  assert.match(second.stderr, new RegExp(`clip2 produced only \\d+ of ${PER_CLIP} frames`),
    'this test depends on failing INSIDE the clip loop; if it now fails earlier, re-point it')

  /* The failure emptied clip2 on the way out, so the first run's config.js is now a lie about a
     directory that no longer exists. */
  assert.equal(fs.existsSync(path.join(s.outDir, 'clip2')), false,
    'abort() removes the half-built clip directory - that is what makes the old config stale')

  assert.equal(fs.existsSync(s.cfg), false,
    'the previous run\'s config.js survived a failed rebuild. It still names clip2 and every one ' +
    `of its ${PER_CLIP} frames, and clip2 is gone - an already-wired page 404s the lot. ` +
    'config.js has to be removed BEFORE the first clip directory is touched.')

  /* And nothing half-written left behind either: the config is written tmp-then-renamed. */
  assert.equal(fs.existsSync(s.cfg + '.tmp'), false, 'no half-written config may be left on disk')
})

test('a config seeded by hand is removed before the first clip directory is touched', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  /* The same property without depending on a successful first run, and with a claim big enough
     that no failing build could ever coincidentally produce it. If the removal is deleted, this
     exact text is what the page goes on reading after the build refused to finish. */
  const s = tree()
  s.truncated()
  fs.mkdirSync(s.outDir, { recursive: true })
  fs.writeFileSync(s.cfg, 'window.HERO_EXT="webp";\nwindow.HERO_SEQ=[\n' +
    '  {"dir":"clip1","n":40,"k":"01 · SEEDED","t":"from a build that is no longer on disk"},\n' +
    '  {"dir":"clip2","n":40,"k":"02 · SEEDED","t":"from a build that is no longer on disk"},\n];\n')

  const r = s.run()
  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, new RegExp(`clip2 produced only \\d+ of ${PER_CLIP} frames`))

  assert.equal(fs.existsSync(s.cfg), false,
    'the stale config.js is still there. It claims 40 frames in each of two clips; the run that ' +
    'just failed rebuilt clip1 with ' + PER_CLIP + ' and left clip2 empty.')

  /* Nothing anywhere in the output tree still carries the old index. */
  for (const f of fs.readdirSync(s.outDir)) {
    if (!fs.statSync(path.join(s.outDir, f)).isFile()) continue
    assert.doesNotMatch(fs.readFileSync(path.join(s.outDir, f), 'utf8'), /SEEDED/,
      `${f} still holds the seeded index`)
  }
})

test('a failing run does not remove a config that belongs to a DIFFERENT output tree', (t) => {
  if (!FF.ok) { t.skip(`needs a working ffmpeg to cut real frames - ${FF.why}`); return }

  /* The bound on the fix. Removing config.js is destructive, so it has to be scoped to --out and
     nothing else - a build-frames that swept more widely would be a worse bug than the one being
     fixed here, and it would pass every assertion above. */
  const s = tree()
  s.truncated()
  const neighbour = path.join(path.dirname(s.outDir), 'other-hero')
  fs.mkdirSync(neighbour, { recursive: true })
  fs.writeFileSync(path.join(neighbour, 'config.js'), 'window.OTHER_SEQ=[];\n')

  const r = s.run()
  assert.equal(r.status, 1, r.out)
  assert.equal(fs.existsSync(path.join(neighbour, 'config.js')), true,
    'only the config inside --out may be removed')
})
