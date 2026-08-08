/* The arithmetic that decides whether somebody spends real money.

   scripts/pricing.mjs already carries a `--self-test`, and it is a good one. It is not a
   substitute for this file, for a reason worth writing down: the self-test lives INSIDE the file
   it checks. Anyone editing a rate has both numbers in front of them, so the one change that
   matters most - a figure moving without anyone noticing - can be made and made consistent in a
   single edit, and the check goes green having verified that pricing.mjs agrees with pricing.mjs.
   The pinned table below is deliberately somewhere else, so moving a rate means touching two files
   and one of them says out loud that the number is supposed to be stable.

   Everything here is offline. pricing.mjs imports nothing from this repo and reaches the network
   only through fetchBalance, which is not touched in this file at all (see
   pricing-balance.test.mjs, which drives it through its injected-fetch seam).

   What is being stood on:
     - the credit -> USD conversion, and the owner's anchor that 1000 credits is exactly $5.00
     - each estimator, at pinned credit AND dollar figures, so a rate that moves is a red test
       rather than a quietly larger bill
     - a range never inverts, never renders a real charge as $0.00, and a point rate never
       renders as a fake range
     - a rate the table does not have is UNKNOWN, and an unknown part makes a total a FLOOR.
       Anything that lets an unpriced row count as zero is the failure this file exists to catch:
       it makes an expensive run look cheap at the exact moment somebody is answering y/n. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RATES, loadRates, estimateKeyframes, estimateTween, estimateStoryboard, estimateRun, combine,
  formatCost, formatBreakdown,
} from '../scripts/pricing.mjs'
import { tmpDir } from './helpers/harness.mjs'

/* An empty directory, so a ./ssh-rates.json sitting in whatever cwd the suite was launched from
   cannot reach in and reprice every assertion below. env {} does the same for SSH_RATES. */
const NOWHERE = tmpDir('ssh-rates-none-')
const R = () => loadRates({ env: {}, cwd: NOWHERE, quiet: true })

/* Dollars are credits x 0.005, and 0.005 has no exact binary representation, so 10 x 0.005 is
   0.049999999999999996 and 6 x 0.005 is 0.030000000000000002. Comparing those with === would make
   this file fail for a reason that has nothing to do with pricing. The one place exact equality IS
   asserted is the $5 anchor, where it happens to land exactly and where an approximation would
   weaken the only figure the owner measured directly. */
const near = (a, b, m = '') => assert.ok(Math.abs(a - b) < 1e-9, `${m} expected ~${b}, got ${a}`)

/* The rate table as it was read off kie.ai's own pages on 2026-08-07, in credits per unit -
   except creditUsd, which is dollars per credit. Written out again here ON PURPOSE. */
const PINNED = {
  creditUsd: [0.005, 0.005],
  'image.1K': [6, 6],
  'image.2K': [10, 10],
  'image.4K': [16, 16],
  'video.std': [14, 14],
  'video.pro': [18, 18],
  'video.4K': [67, 67],
  'sol.call': [0.84, 6.72],
}

test('every rate is still the number it was when it was read off kie.ai', () => {
  /* Key parity first. Without it a new row could be added, priced wrongly, and never noticed by
     this file - the loop below would simply not visit it. */
  assert.deepEqual(Object.keys(RATES).sort(), Object.keys(PINNED).sort(),
    'a row was added or removed - pin its rate here, or a new model ships unchecked')

  for (const [key, [low, high]] of Object.entries(PINNED)) {
    const e = R().entries[key]
    assert.equal(e.low, low, `${key} low moved - if kie.ai really changed it, update PINNED and say so in the commit`)
    assert.equal(e.high, high, `${key} high moved`)
  }
})

test('1000 credits is exactly $5.00 - the anchor the whole table hangs off', () => {
  /* $5 = 1000 credits is what the account holder actually paid, and it is the one figure every
     other number here is derived from. Asserted three ways because the conversion can be broken
     in three places: the rate, the multiply, and the render. */
  assert.equal(RATES.creditUsd.low, 0.005)
  assert.equal(RATES.creditUsd.high, 0.005)
  assert.equal(1000 * RATES.creditUsd.low, 5)

  /* 100 stills at 2K is exactly 1000 credits, which makes this the cheapest way to drive the
     conversion through a real estimate rather than round-tripping the constant. */
  const e = estimateKeyframes({ count: 100, resolution: '2K', rates: R() })
  assert.equal(e.credits.low, 1000)
  assert.equal(e.credits.high, 1000)
  assert.equal(e.usd.low, 5, 'exactly $5.00, not approximately')
  assert.equal(e.usd.high, 5)
  assert.equal(formatCost(e), '~1,000 credits (~$5.00)')
})

test('keyframes: each resolution prices at kie.ai\'s own quote', () => {
  const rates = R()
  /* "6 credits ($0.03) for 1 K, 10 credits ($0.05) for 2 K, and 16 credits ($0.08) for 4 K" -
     one image each, so the credits and the dollars are the vendor's line verbatim. */
  for (const [resolution, credits, usd] of [['1K', 6, 0.03], ['2K', 10, 0.05], ['4K', 16, 0.08]]) {
    const e = estimateKeyframes({ count: 1, resolution, rates })
    assert.equal(e.credits.low, credits, resolution)
    near(e.usd.low, usd, `${resolution} in dollars`)
    assert.equal(e.confidence, 'high')
  }
  const six = estimateKeyframes({ count: 6, resolution: '2K', rates })
  assert.equal(six.credits.low, 60)
  assert.equal(formatCost(six), '~60 credits (~$0.30)')
})

test('tween: each mode prices at kie.ai\'s own no-audio quote, per second', () => {
  const rates = R()
  /* Five 5s segments = 25s of finished video, which is the shape of a six-step storyboard and
     therefore the number an operator sees most often. */
  for (const [mode, credits, line] of [
    ['std', 350, '~350 credits (~$1.75)'],
    ['pro', 450, '~450 credits (~$2.25)'],
    ['4K', 1675, '~1,675 credits (~$8.38)'],
  ]) {
    const e = estimateTween({ segments: 5, seconds: 5, mode, rates })
    assert.equal(e.credits.low, credits, mode)
    assert.equal(e.credits.high, credits, `${mode} must not invent a spread it does not have`)
    assert.equal(formatCost(e), line, mode)
  }

  /* 4K is the flag that changes a decision, so the gap is pinned separately from the figures:
     the same run costs 3.7x more on one word, and nothing else in the output shouts about it. */
  const pro = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates })
  const uhd = estimateTween({ segments: 5, seconds: 5, mode: '4K', rates })
  assert.equal(uhd.credits.low - pro.credits.low, 1225)
  near(uhd.usd.low - pro.usd.low, 6.125)

  /* Per SECOND, not per segment. Halving the duration has to halve the bill, or the number the
     gate prints is not answering the question the operator is actually asking. */
  assert.equal(estimateTween({ segments: 5, seconds: 3, mode: 'pro', rates }).credits.low, 270)
  assert.equal(estimateTween({ segments: 1, seconds: 5, mode: 'pro', rates }).credits.low, 90)
})

test('storyboard: an honest token bound, never "free" and never a fake point figure', () => {
  const e = estimateStoryboard({ rates: R() })
  assert.equal(e.credits.low, 0.84, 'floor: 3k tokens, all input')
  assert.equal(e.credits.high, 6.72, 'ceiling: 4k tokens, all output')
  assert.equal(e.confidence, 'medium', 'the one derived row must not claim to be a vendor quote')

  const line = formatCost(e)
  assert.doesNotMatch(line, /free/i, 'a fraction of a cent is still a charge')
  assert.match(line, /token-count bound/, 'the softest number in the table has to say it is soft')
  /* The reason the range is not collapsed to two decimal places. "$0.00" next to a real charge is
     the one rendering that teaches somebody to stop reading the cost line. */
  assert.doesNotMatch(line, /\$0\.00\b/)
  assert.match(line, /\$0\.004-\$0\.034/)
})

test('run: the three stages sum, and the total inherits the weakest confidence', () => {
  const run = estimateRun({ steps: 6, seconds: 5, mode: 'pro', resolution: '2K', rates: R() })

  assert.equal(run.parts.length, 3)
  assert.equal(run.credits.low, 0.84 + 60 + 450)
  assert.equal(run.credits.high, 6.72 + 60 + 450)
  assert.equal(run.partial, false, 'every part is priced, so this is a total and not a floor')
  assert.equal(run.confidence, 'medium', 'a chain is as trustworthy as its worst link, and Sol is it')
  assert.equal(formatCost(run), '~511-517 credits (~$2.55-$2.58)')

  const lines = formatBreakdown(run)
  assert.equal(lines.length, 4, 'one line per stage plus a total')
  assert.match(lines[0], /^storyboard /)
  assert.match(lines[1], /^keyframes {2}~60 credits/)
  assert.match(lines[2], /^video {6}~450 credits/)
  assert.match(lines[3], /^total {6}~511-517 credits/)
})

test('run: a supplied "after" photo is one still nobody pays for', () => {
  const rates = R()
  const synth = estimateRun({ steps: 6, realAfter: false, rates })
  const real = estimateRun({ steps: 6, realAfter: true, rates })
  assert.equal(synth.credits.low - real.credits.low, 10, 'exactly one 2K still')
  near(synth.usd.low - real.usd.low, 0.05)
})

test('a rate the table does not have is UNKNOWN, and never zero', () => {
  const rates = R()

  for (const [est, needle] of [
    [estimateKeyframes({ count: 6, resolution: '8K', rates }), /no rate for GPT Image 2 at 8K/],
    [estimateTween({ segments: 5, seconds: 5, mode: 'ultra', rates }), /no rate for Kling 3\.0 in ultra mode/],
  ]) {
    assert.equal(est.known, false)
    assert.equal(est.credits, null, 'an unpriced order must not fall through to a credits figure')
    assert.equal(est.usd, null)
    assert.match(est.reason, needle)
    assert.match(formatCost(est), /^cost unknown - /)
    /* Not "$0.00", not "0 credits", not "free". Every one of those reads as "go ahead". */
    assert.doesNotMatch(formatCost(est), /\$0\.00|\b0 credits\b|free/i)
  }

  /* The known-set list has to come off the table rather than be written out again, or the day a
     row is added the error message advertises a shorter list than the code accepts. */
  assert.match(estimateTween({ segments: 1, mode: 'ultra', rates }).reason, /known: std, pro, 4K/)
})

test('an unpriceable part makes the total a FLOOR, and names what is missing', () => {
  /* The whole point of `partial`. A total that silently dropped the stage it could not price
     would understate the run and look like a confident answer while doing it. */
  const run = estimateRun({ steps: 6, resolution: '8K', rates: R() })

  assert.equal(run.partial, true)
  assert.equal(run.credits.low, 0.84 + 450, 'Sol and video only - the stills are excluded, not zeroed')
  const line = formatCost(run)
  assert.match(line, /^at least /, 'a floor must not be printed as if it were a total')
  assert.match(line, /excludes: /)
  assert.match(line, /8K/, 'and it has to name the stage that could not be priced')
})

test('a rate row marked unknown refuses rather than billing at nothing', () => {
  /* Every built-in row is priced today, so nothing exercises this path by accident. It is the
     guard that keeps "all rows happen to be known" from being load-bearing: the day a mode is
     added without a rate, it has to refuse. */
  const base = R()
  const rates = {
    ...base,
    entries: { ...base.entries, 'video.pro': { ...base.entries['video.pro'], known: false } },
  }
  const e = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates })
  assert.equal(e.known, false)
  assert.equal(e.credits, null)

  const run = combine([estimateKeyframes({ count: 6, rates: base }), e], { kind: 'run' })
  assert.equal(run.partial, true)
  assert.equal(run.credits.low, 60, 'the total is the priced part only')
  assert.match(formatCost(run), /^at least ~60 credits/)
})

test('no estimate can invert: low is never above high', () => {
  const rates = R()
  for (const [key, e] of Object.entries(rates.entries)) {
    assert.ok(e.low <= e.high, `${key} inverts: ${e.low} > ${e.high}`)
    assert.ok(e.low >= 0, `${key} is negative`)
  }

  const all = []
  for (const resolution of ['1K', '2K', '4K']) {
    for (const count of [0, 1, 6, 100]) all.push(estimateKeyframes({ count, resolution, rates }))
  }
  for (const mode of ['std', 'pro', '4K']) {
    for (const seconds of [3, 5, 10]) {
      for (const segments of [0, 1, 5]) all.push(estimateTween({ segments, seconds, mode, rates }))
    }
  }
  all.push(estimateStoryboard({ rates }))
  for (const steps of [1, 2, 6, 12]) {
    for (const realAfter of [false, true]) all.push(estimateRun({ steps, realAfter, rates }))
  }

  for (const e of all) {
    assert.equal(e.known, true, e.reason)
    assert.ok(e.credits.low <= e.credits.high, `${e.basis}: credits invert`)
    assert.ok(e.usd.low <= e.usd.high, `${e.basis}: dollars invert`)
    assert.ok(e.credits.low >= 0 && e.usd.low >= 0, `${e.basis}: negative`)
    /* The dollars must be the credits through the one conversion, at both ends. A separate
       dollar path is how a pinned creditUsd ends up moving one figure and not the other. Only for
       the leaf estimates: a run's dollars are the SUM of its parts' dollars, which is the same
       arithmetic in a different order and drifts from this product in the last bit. */
    if (e.rate) {
      near(e.usd.low, e.credits.low * rates.entries.creditUsd.low, `${e.basis}: usd low`)
      near(e.usd.high, e.credits.high * rates.entries.creditUsd.high, `${e.basis}: usd high`)
    }
  }
})

test('a pinned range that arrives backwards is straightened, not obeyed', () => {
  /* {"video.std": [20, 14]} is a plausible typo and it would otherwise produce an estimate whose
     low is above its high - which every downstream comparison, including the balance shortfall
     check, reads the wrong way round. */
  const rates = loadRates({ env: { SSH_RATES: '{"video.std":[20,14]}' }, cwd: NOWHERE, quiet: true })
  assert.equal(rates.problems.length, 0, rates.problems.join('; '))
  assert.equal(rates.entries['video.std'].low, 14)
  assert.equal(rates.entries['video.std'].high, 20)

  const e = estimateTween({ segments: 1, seconds: 10, mode: 'std', rates })
  assert.ok(e.credits.low <= e.credits.high)
  assert.equal(e.credits.low, 140)
  assert.equal(e.credits.high, 200)
  assert.equal(formatCost(e), '~140-200 credits (~$0.70-$1.00)')
})

test('a range prints as a range and a point prints as a point', () => {
  /* Both directions matter. A real spread collapsed to one figure is false precision - it claims
     to know a number it does not. A point rate rendered as "~450-450" is the same lie backwards:
     it makes a firm vendor quote look like a guess, and then nobody trusts either kind. */
  const point = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: R() })
  assert.equal(formatCost(point), '~450 credits (~$2.25)')
  assert.doesNotMatch(formatCost(point), /450-450|\$2\.25-\$2\.25/)

  const spread = estimateStoryboard({ rates: R() })
  assert.match(formatCost(spread), /~1-7 credits/, 'a genuine spread must survive rendering')
  assert.match(formatCost(spread), /\$0\.004-\$0\.034/)

  /* And the mixed case: a run whose only soft part is Sol still prints a range, because part of
     the bill genuinely is not known to the cent. */
  const run = estimateRun({ steps: 6, rates: R() })
  assert.match(formatCost(run), /~511-517 credits \(~\$2\.55-\$2\.58\)/)
})

test('a pinned rate replaces the built-in outright and stops being called an estimate', () => {
  const rates = loadRates({ env: { SSH_RATES: '{"video":{"pro":6},"creditUsd":0.004}' }, cwd: NOWHERE, quiet: true })
  const e = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates })

  assert.equal(e.credits.low, 150, '25s at the pinned 6, not the built-in 18')
  near(e.usd.low, 0.6, 'and through the pinned conversion, not the built-in one')
  assert.equal(e.confidence, 'user', 'somebody who pinned their own rate knows their tier better than we do')
  assert.equal(e.caveat, '')
  assert.ok(e.pinned)
  assert.match(formatBreakdown(estimateRun({ steps: 6, rates })).join('\n'), /\(your pinned rate\)/)
})

test('a malformed override never silently changes the number', () => {
  /* Reported, not obeyed, and not fatal. Someone pinned a rate precisely because ours is wrong
     for them; quietly reverting to ours prices their run at a figure they already rejected. */
  for (const [json, needle] of [
    ['not json', /not valid JSON/],
    ['{"video":{"pro":"cheap"}}', /must be a number/],
    ['{"video":{"pro":-3}}', /must be a number/],
    ['{"video":{"pro":{"usd":0.09}}}', /denominated in CREDITS, not dollars/],
    ['{"creditUsd":200}', /DOLLARS PER CREDIT/],
  ]) {
    const rates = loadRates({ env: { SSH_RATES: json }, cwd: NOWHERE, quiet: true })
    assert.ok(rates.problems.length, `${json} was accepted in silence`)
    assert.match(rates.problems[0], needle, json)
    assert.equal(rates.entries['video.pro'].low, 18, `${json} moved the built-in rate`)
    assert.equal(rates.entries.creditUsd.low, 0.005, `${json} moved the conversion`)
    assert.equal(estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates }).credits.low, 450, json)
  }
})
