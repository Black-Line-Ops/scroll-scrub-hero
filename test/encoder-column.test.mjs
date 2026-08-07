/* The libwebp check, in the two places it is written: doctor.mjs's preflight and ffmpegStatus()
   in test/helpers/harness.mjs.

   Both are POSITIVE assertions about a build nobody has run yet. doctor.mjs prints
   "OK    ffmpeg can encode WebP (libwebp)" and lets an operator start a pipeline whose last step
   hard-codes `-c:v libwebp` with no fallback - so a wrong answer here is discovered after the
   storyboard, every keyframe and every tween have already been paid for.

   The subtlety, and the reason a naive test misses this entirely: real ffmpeg prints TWO rows,
   and BOTH carry the standalone token "libwebp" in the DESCRIPTION column -

       V....D libwebp_anim         libwebp WebP image (codec webp)
       V....D libwebp              libwebp WebP image (codec webp)

   so /\blibwebp\b/ - what this check used to use - returns true on a build that has only the
   ANIMATION encoder, which cannot answer to `-c:v libwebp`. A listing containing NEITHER row is
   refused by both the old regex and the new one, so a test built only from that fixture is green
   against the bug. The ANIM-ONLY listing is the single input that tells the two apart, and it is
   the reason this file exists. Every fixture below is in the real column format for that reason:
   collapse the whitespace and the anim row stops being a description-column false positive, and
   the test stops testing anything.

   Neither copy of the check can be called directly:
     - doctor.mjs is a top-level program that fires four network probes on load, so importing it
       would put the suite on the network. Same constraint doctor-mask.test.mjs works around, and
       the same workaround: lift the shipped expression out of the shipped file and evaluate that.
     - ffmpegStatus() runs the real ffmpeg off PATH. Feeding it a synthetic listing would mean
       putting a fake ffmpeg on PATH, which is not portable - Node refuses to spawn a .cmd/.bat
       without a shell, so there is no fake executable to write on Windows. So its regex is lifted
       the same way, and the FUNCTION is separately cross-checked against this machine's real
       listing using an independent column parse.

   ffmpegStatus() is worth its own coverage for a reason that is easy to miss: a broken regex there
   makes ffmpegStatus() return {ok:false}, which SKIPS every ffmpeg-backed frame test rather than
   failing one. The suite stays green and quietly stops checking build-frames.mjs. So the assertion
   has to be about ffmpegStatus() itself; "the suite is green" is not evidence about it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, SCRIPTS, ffmpegStatus } from './helpers/harness.mjs'

const HARNESS = path.join(ROOT, 'test', 'helpers', 'harness.mjs')

/* Pull the regex literal off the one line that tests the encoder listing. Deliberately literal
   about where it looks: if the check is ever rewritten into a shape this cannot find, the test
   fails asking to be re-pointed rather than quietly stopping checking. */
function liftEncoderRegex (file) {
  const source = fs.readFileSync(file, 'utf8')
  const lines = source.split('\n').filter(l => l.includes('.test(encoders)'))
  if (lines.length !== 1) {
    return { why: `expected exactly one line calling .test(encoders) in ${file}, found ${lines.length}` }
  }
  const m = lines[0].match(/\/(.+?)\/([gimsuy]*)\.test\(encoders\)/)
  if (!m) return { why: `no regex literal on that line in ${file}: ${lines[0].trim()}` }
  return { literal: `/${m[1]}/${m[2]}`, re: new RegExp(m[1], m[2]) }
}

const DOCTOR = liftEncoderRegex(path.join(SCRIPTS, 'doctor.mjs'))
const HELPER = liftEncoderRegex(HARNESS)

/* Real ffmpeg -hide_banner -encoders output, columns intact. The header is included because the
   match is anchored to the start of a row and those lines are rows too. */
const HEADER = [
  'Encoders:',
  ' V..... = Video',
  ' A..... = Audio',
  ' S..... = Subtitle',
  ' .F.... = Frame-level multithreading',
  ' ..S... = Slice-level multithreading',
  ' ...X.. = Codec is experimental',
  ' ....B. = Supports draw_horiz_band',
  ' .....D = Supports direct rendering method 1',
  ' ------',
  ' V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)',
  ' V....D libwebp_anim         libwebp WebP image (codec webp)',
].join('\n') + '\n'

/* The still-image encoder, which is the only one build-frames.mjs can use. */
const STILL_ROW = ' V....D libwebp              libwebp WebP image (codec webp)\n'

const REAL = HEADER + STILL_ROW      /* what ffmpeg 8.1.1 on Windows prints: both rows */
const ANIM_ONLY = HEADER             /* the anim row and nothing else - the discriminating case */
const NEITHER = HEADER.replace(' V....D libwebp_anim         libwebp WebP image (codec webp)\n', '')

test('the encoder check is where these tests expect it', () => {
  assert.ok(DOCTOR.re, `${DOCTOR.why}\nIf the libwebp check was refactored, re-point this test at it - do not delete it.`)
  assert.ok(HELPER.re, `${HELPER.why}\nIf ffmpegStatus() was refactored, re-point this test at it - do not delete it.`)
})

/* The fixture has to be able to catch the bug before any assertion made with it means anything.
   /\blibwebp\b/ is the exact regex that shipped, and it must MATCH the anim-only listing - that
   false positive is the defect. If someone edits the rows below into a shape the old regex also
   rejects, every test under this one starts passing for free, so this fails first and says why. */
test('the anim-only fixture is the one that catches the old regex', () => {
  assert.match(ANIM_ONLY, /\blibwebp\b/,
    'the anim row must carry a standalone "libwebp" in its DESCRIPTION column, or these fixtures ' +
    'cannot distinguish the broken regex from the fixed one and this whole file is decoration')
  assert.doesNotMatch(NEITHER, /\blibwebp\b/,
    'the no-webp fixture is a control: BOTH regexes refuse it, so on its own it proves nothing')
})

for (const [where, lifted] of [['doctor.mjs', DOCTOR], ['harness.mjs ffmpegStatus()', HELPER]]) {
  test(`${where} accepts a real listing that has the still encoder`, () => {
    assert.ok(lifted.re, lifted.why)
    assert.equal(lifted.re.test(REAL), true,
      `${lifted.literal} rejected a real ffmpeg listing - that sends someone to reinstall an ` +
      'ffmpeg that is already correct, and in the harness it silently skips the frame tests')
  })

  test(`${where} REFUSES a listing that has only libwebp_anim`, () => {
    assert.ok(lifted.re, lifted.why)
    assert.equal(lifted.re.test(ANIM_ONLY), false,
      `${lifted.literal} matched the description column of the libwebp_anim row. That build ` +
      'cannot answer to `-c:v libwebp`, so build-frames.mjs writes no frames - after both paid ' +
      'generation steps. Anchor the match to the encoder-NAME column (the second field of a row).')
  })

  test(`${where} refuses a listing with no webp encoder at all`, () => {
    assert.ok(lifted.re, lifted.why)
    assert.equal(lifted.re.test(NEITHER), false)
  })
}

test('the two copies of the check are the same expression', () => {
  assert.ok(DOCTOR.re && HELPER.re, 'both regexes have to be found before they can be compared')
  /* They are duplicated rather than imported because doctor.mjs is a top-level program - importing
     it would run the whole preflight. Duplication is the trade; drift is what it costs, and this
     is the line that refuses to pay it. Fixing one and not the other means preflight certifies a
     build the frame tests then skip, or the reverse. */
  assert.equal(HELPER.literal, DOCTOR.literal,
    'doctor.mjs and harness.mjs must agree about what counts as a usable libwebp, or preflight ' +
    'and the test suite disagree about which ffmpeg builds work')
})

test('ffmpegStatus() itself agrees with a column parse of this machine\'s real listing', (t) => {
  /* The direct assertion about the function, not about a regex lifted out of it. The oracle is
     an independent implementation - split each row on whitespace and look at field 2 - so it
     cannot agree with the regex by construction the way a copied regex would. */
  let listing
  try {
    const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    execFileSync('ffprobe', ['-version'], quiet)          /* ffmpegStatus() requires both binaries */
    listing = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], quiet)
  } catch (e) {
    t.skip(`needs ffmpeg and ffprobe on PATH to have a real listing to parse - ${e.code || e.message}`)
    return
  }

  const rows = listing.split('\n').map(l => l.trim().split(/\s+/))
  const hasStill = rows.some(f => f[1] === 'libwebp')
  const hasAnimOnly = !hasStill && rows.some(f => f[1] === 'libwebp_anim')

  assert.equal(ffmpegStatus().ok, hasStill,
    hasAnimOnly
      ? 'this ffmpeg has libwebp_anim and NOT libwebp, and ffmpegStatus() called it usable - that ' +
        'is the exact false positive this file exists for'
      : `ffmpegStatus() disagrees with the encoder-name column of this machine's own ffmpeg ` +
        `(column parse says ${hasStill}, ffmpegStatus says ${ffmpegStatus().ok}: ${ffmpegStatus().why})`)
})
