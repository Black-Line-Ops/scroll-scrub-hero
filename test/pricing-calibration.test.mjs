/* Calibration: the part that stops the rate table being a guess forever.

   tween.mjs and keyframes.mjs both persist whatever kie.ai reported as creditsConsumed. That is
   GROUND TRUTH; the table in pricing.mjs is not. calibrate() compares the two and, when they
   disagree materially, hands back the measured rate in a form somebody can pin. If that comparison
   is wrong the damage is specific and nasty: it either announces a discrepancy that is not there -
   which trains people to ignore the line - or it stays quiet while the table drifts away from what
   is actually being charged, which is the state this whole exercise exists to leave behind.

   Three traps, and all three are load-bearing enough to have their own test:

     1. UNITS ARE SECONDS. The video rate is quoted per second. Summing segment COUNTS instead of
        durations turns a correct 18 credits/second into a reported 90 and suggests pinning it.
     2. THE COMPARISON IS AGAINST THE NEAREST EDGE of the range, not the midpoint. A range is a
        claim that the truth is inside it, so an observation inside it is right, not "7% off".
     3. BILLED, NOT ORDERED. A run where two of five submits failed must not compare five
        segments' prediction against three segments' bill.

   Nothing here is billable or networked - it is arithmetic over a state-file shape. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  calibrate, observedFromSegments, formatCalibration, estimateTween, estimateKeyframes, loadRates,
} from '../scripts/pricing.mjs'
import { tmpDir } from './helpers/harness.mjs'

const NOWHERE = tmpDir('ssh-cal-rates-')
const R = () => loadRates({ env: {}, cwd: NOWHERE, quiet: true })

/* The shape tween.mjs actually writes: keyed by the step the segment starts from, carrying the
   duration it was generated at alongside the credits kie.ai charged for it. */
const segs = (n, { credits = 90, duration = 5, mode = 'pro' } = {}) => Object.fromEntries(
  Array.from({ length: n }, (_, i) => [i + 1, { from: i + 1, to: i + 2, creditsConsumed: credits, duration, mode, file: `segment-0${i + 1}.mp4` }]))

test('observedFromSegments measures SECONDS, not segments', () => {
  /* The 5x error. Three 5s segments at 90 credits each is 18 credits/second - kie.ai's published
     pro rate. Counting segments instead of seconds makes it 90 credits/second and reports the
     table as 80% low, with a confident suggestion to pin a rate five times too high. */
  const o = observedFromSegments(segs(3))
  assert.equal(o.credits, 270)
  assert.equal(o.units, 15, 'units are seconds - 3 segments x 5s')
  assert.equal(o.segments, 3)
  assert.deepEqual(o.modes, ['pro'])

  const cal = calibrate(estimateTween({ segments: 3, seconds: 5, mode: 'pro', rates: R() }), o, { rates: R() })
  assert.equal(cal.unit, 'second')
  assert.equal(cal.observed.perUnit, 18, 'per SECOND. 90 here would be the segment-count bug')
  assert.equal(cal.within, true)

  /* A different duration at the same per-second rate must still read as the table holding, which
     is only true if the seconds are what got summed. */
  const short = observedFromSegments(segs(3, { credits: 54, duration: 3 }))
  assert.equal(short.units, 9)
  assert.equal(calibrate(estimateTween({ segments: 3, seconds: 3, mode: 'pro', rates: R() }), short, { rates: R() }).observed.perUnit, 18)
})

test('a segment kie.ai never billed for is not counted as free work', () => {
  /* A submitted-but-failed segment sits in state with a taskId and no creditsConsumed. Counting
     its seconds while not counting its credits would drag the measured rate down and "prove" the
     table is high. */
  const state = { ...segs(2), 3: { from: 3, to: 4, taskId: 'x', duration: 5, mode: 'pro' } }
  const o = observedFromSegments(state)
  assert.equal(o.credits, 180)
  assert.equal(o.units, 10, 'the unbilled segment contributes neither credits nor seconds')
  assert.equal(o.segments, 2)

  /* And nothing at all is null, not zero: zero credits is a measurement, absence is not. This
     sentinel is the whole contract - both callers gate their calibration on having at least one
     billed id before they ever reach calibrate(), and they have to, because calibrate() reads a
     {credits: null} observation as a measured 0 and would announce the table 100% high. Asserted
     here as the shape callers must keep checking, not as an endorsement of that edge. */
  assert.equal(observedFromSegments({}).credits, null)
  assert.equal(observedFromSegments({}).segments, 0)
  assert.equal(observedFromSegments({ 1: { taskId: 'x', duration: 5 } }).credits, null)
  assert.equal(observedFromSegments(segs(2), { only: [] }).credits, null, 'nothing billed this run')
  assert.equal(observedFromSegments(undefined).credits, null)

  /* The route that is safe without a caller-side guard: an empty per-item array. */
  assert.equal(calibrate(estimateTween({ segments: 1, rates: R() }), []).ok, false)
  assert.deepEqual(formatCalibration(calibrate(estimateTween({ segments: 1, rates: R() }), [])), [],
    'no observation means no verdict, not a verdict of zero')
})

test('--only restricts the observation to the segments this run paid for', () => {
  /* state carries every segment ever billed for this storyboard; `generated` is what this process
     just paid for. Mixing them attributes an earlier run's spend to today's estimate. */
  const state = segs(5)
  assert.equal(observedFromSegments(state).credits, 450)
  assert.equal(observedFromSegments(state, { only: [3] }).credits, 90)
  assert.equal(observedFromSegments(state, { only: [3] }).units, 5)
  assert.equal(observedFromSegments(state, { only: [2, 4] }).segments, 2)
  /* ids arrive as strings from Object.keys and as numbers from the motions list. Both have to
     match, or --only silently observes nothing and the run reports itself unmeasured. */
  assert.equal(observedFromSegments(state, { only: ['3'] }).credits, 90)
})

test('a bill materially above the estimate is detected, named, and made pinnable', () => {
  /* 27 credits/second is not a hypothetical: it is what Kling's OWN platform quotes per second in
     its own credit denomination, which is a different currency from kie.ai's. Somebody reading the
     wrong page and pinning it is exactly how the table would end up 50% out. */
  const est = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: R() })   /* 450 */
  const cal = calibrate(est, { credits: 675, units: 25 }, { rates: R() })

  assert.equal(cal.within, false, 'a 50% miss must not be waved through')
  assert.equal(cal.delta.credits, 225)
  assert.equal(cal.delta.pct, 50)
  assert.equal(cal.observed.perUnit, 27)
  assert.deepEqual(cal.suggestion, {
    key: 'video.pro',
    unit: 'second',
    creditsPerUnit: 27,
    usdPerUnit: 0.135,
    json: '{"video.pro":27}',
  })

  const lines = formatCalibration(cal)
  assert.match(lines[0], /^billed 675 credits for 25 seconds; the built-in estimate said ~450 credits, so the built-in rate is 50% LOW\.$/)
  assert.match(lines[1], /your real rate is 27 credits\/second/)
  /* The pin has to be copy-pasteable on both shells this skill supports. Windows is not an
     afterthought here: the POSIX form silently sets nothing in PowerShell. */
  assert.match(lines[2], /SSH_RATES=\{"video\.pro":27\}/)
  assert.match(lines[2], /\$env:SSH_RATES='\{"video\.pro":27\}'/)
})

test('a bill materially below the estimate reads HIGH, not LOW', () => {
  /* The direction is the whole message. Getting it backwards tells somebody on a discount tier to
     pin a rate above what they are being charged. */
  const est = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: R() })   /* 450 */
  const cal = calibrate(est, { credits: 150, units: 25 }, { rates: R() })

  assert.equal(cal.within, false)
  assert.equal(cal.delta.credits, -300)
  assert.equal(cal.suggestion.creditsPerUnit, 6)
  assert.match(formatCalibration(cal)[0], /so the built-in rate is 67% HIGH\.$/)
})

test('the verdict is measured from the nearest EDGE of the range', () => {
  /* Inside the range is correct, not "off by the distance to the middle". Every built-in row is a
     point value today, so this arithmetic has nothing exercising it unless a range is pinned - and
     it is the arithmetic that decides whether the softest rate in the table ever gets corrected. */
  const rates = loadRates({ env: { SSH_RATES: '{"video.std":[14,20]}' }, cwd: NOWHERE, quiet: true })
  const est = estimateTween({ segments: 1, seconds: 10, mode: 'std', rates })       /* 140-200 */

  for (const credits of [140, 170, 200]) {
    const cal = calibrate(est, { credits, units: 10 }, { rates })
    assert.equal(cal.delta.credits, 0, `${credits} is inside the range and must score zero delta`)
    assert.equal(cal.within, true)
    assert.equal(cal.suggestion, null, 'nothing to suggest when the table was right')
    assert.match(formatCalibration(cal)[0], /rate table held/)
  }
  /* 15% of the top edge is 30 credits, so 230 is the last observation still inside tolerance. */
  assert.equal(calibrate(est, { credits: 230, units: 10 }, { rates }).within, true)
  assert.equal(calibrate(est, { credits: 231, units: 10 }, { rates }).within, false)
  /* ...and symmetrically off the bottom edge: 15% of 140 is 21. */
  assert.equal(calibrate(est, { credits: 119, units: 10 }, { rates }).within, true)
  assert.equal(calibrate(est, { credits: 118, units: 10 }, { rates }).within, false)
})

test('tolerance is honoured exactly at the edge of a point estimate', () => {
  const est = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: R() })   /* 450 */
  assert.equal(calibrate(est, { credits: 517, units: 25 }, { rates: R() }).within, true, '14.9% over')
  assert.equal(calibrate(est, { credits: 518, units: 25 }, { rates: R() }).within, false, '15.1% over')
  /* A caller may tighten it, and the tighter number has to actually be used. */
  assert.equal(calibrate(est, { credits: 470, units: 25 }, { tolerance: 0.01, rates: R() }).within, false)
  assert.equal(calibrate(est, { credits: 470, units: 25 }, { tolerance: 0.5, rates: R() }).within, true)
})

test('comparing ORDERED segments against a BILLED subset is what produces a false verdict', () => {
  /* This is why tween.mjs re-estimates for `billed.length` at the end of a run rather than reusing
     the estimate it printed at the gate. Five segments were ordered; two submits failed; three
     were billed at exactly kie.ai's published rate.

     The wrong composition reports the table is 40% high AND suggests pinning 18 credits/second -
     the number already in the table. A recommendation to replace a rate with itself is the
     signature of this bug, so it is asserted as well as the percentage. */
  const state = segs(3)
  const observed = observedFromSegments(state)

  const ordered = calibrate(estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: R() }), observed, { rates: R() })
  assert.equal(ordered.within, false)
  assert.match(formatCalibration(ordered)[0], /40% HIGH/)
  assert.equal(ordered.suggestion.creditsPerUnit, 18, 'it "corrects" the rate to the rate it already had')

  const billed = calibrate(estimateTween({ segments: 3, seconds: 5, mode: 'pro', rates: R() }), observed, { rates: R() })
  assert.equal(billed.within, true)
  assert.equal(billed.suggestion, null)
  assert.deepEqual(formatCalibration(billed),
    ['billed 270 credits for 15 seconds; the built-in estimate said ~270 credits, so the rate table held.'])
})

test('an unpriceable estimate produces no verdict at all', () => {
  /* Nothing to compare against is not the same as agreement. A calibration that reported "the
     rate table held" for a mode the table cannot price would be a confident wrong number, which
     is the exact defect the whole file was written against. */
  const cal = calibrate(estimateTween({ segments: 3, seconds: 5, mode: 'ultra', rates: R() }), { credits: 270, units: 15 })
  assert.equal(cal.ok, false)
  assert.match(cal.reason, /nothing to compare against/)
  assert.deepEqual(formatCalibration(cal), [])
  assert.deepEqual(formatCalibration(null), [])
})

test('the measured rate is quoted in the run\'s own conversion, pinned or not', () => {
  /* Quoting somebody's measured rate in our dollars instead of theirs would undo the point of
     measuring it. */
  const rates = loadRates({ env: { SSH_RATES: '{"creditUsd":0.004}' }, cwd: NOWHERE, quiet: true })
  const cal = calibrate(estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates }), { credits: 150, units: 25 }, { rates })
  assert.equal(cal.suggestion.creditsPerUnit, 6)
  assert.ok(Math.abs(cal.suggestion.usdPerUnit - 0.024) < 1e-9, `usd/second was ${cal.suggestion.usdPerUnit}`)
  assert.match(formatCalibration(cal)[1], /\(~\$0\.0240\/second\)/)
})

test('a per-item array of credits is accepted, and stills calibrate per IMAGE', () => {
  /* keyframes.mjs calibrates too, and its unit is the image rather than the second. Same
     machinery, different denominator - if the unit label ever came from the wrong place it would
     show up here as "per second". */
  const est = estimateKeyframes({ count: 6, resolution: '2K', rates: R() })          /* 60 */
  const cal = calibrate(est, { credits: 60, units: 6 }, { rates: R() })
  assert.equal(cal.unit, 'image')
  assert.equal(cal.observed.perUnit, 10)
  assert.equal(cal.within, true)

  const arr = calibrate(estimateTween({ segments: 3, seconds: 5, mode: 'pro', rates: R() }), [90, 90, 90], { rates: R() })
  assert.equal(arr.observed.credits, 270)
  assert.equal(arr.within, true)
  /* No units given, so it falls back to the estimate's own - which is right only because the
     array covers the whole estimate. */
  assert.equal(arr.observed.units, 15)
})
