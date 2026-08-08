/* What a run costs, in one place, with the provenance of every number attached.

   The two spend gates in this pipeline used to say "check kie.ai; this script does not know your
   rate and will not invent one". That was honest and useless in equal measure: nobody can approve
   a charge they cannot see the size of. The fix is not to start inventing rates - it is to carry
   each rate TOGETHER WITH how well it is known, so a printed figure can admit what it is.

   WHERE THE NUMBERS COME FROM, AND HOW THAT WAS ESTABLISHED. On 2026-08-07 kie.ai's own public
   pages were fetched unauthenticated - free, and safe, because a GET of a marketing page creates
   nothing - and each model's rate was read out of the page's own data rather than off a
   third-party summary. Every row below names the exact URL it came from, so the next person can
   re-run the same check instead of trusting this file's word for it. That is deliberate: this
   repo has already been bitten by a reference doc that claimed "Verified August 2026" over
   contracts that were wrong, and a date without a re-runnable check is decoration.

   The one row that is NOT a direct vendor quote is the Sol storyboard call, because Sol is billed
   per token and the token count of a run is not a published constant. Its per-token rates are
   kie.ai's; the per-call figure is derived from those plus one measured run, and it is a wide
   range rather than a figure, because the input/output split is unknown and output tokens cost 6x
   input.

   Two rules follow, and they are the whole point of this file:

     A confident wrong number is worse than an honest range, so nothing here returns a bare
     scalar. Every estimate is {low, high} with a confidence and, where confidence is poor, a
     one-clause caveat the caller is expected to print.

     An estimate that never learns is a guess forever. tween.mjs already writes kie.ai's real
     creditsConsumed into segments/_state.json; calibrate() below compares that against what this
     table predicted and hands back the measured rate, ready to pin. That is how the third-party
     number above stops being a third-party number.

   Deliberately imports nothing from this repo, only node builtins. Two reasons. The test harness
   stages a script into a temp directory beside a generated stub kie.mjs (test/helpers/harness.mjs),
   and a module with no local imports can be copied in verbatim with nothing to stub. And a pricing
   table that cannot itself spend money is one less thing to audit.

   Run it directly:
     node scripts/pricing.mjs              print the rate table with provenance
     node scripts/pricing.mjs --self-test  check the arithmetic offline, no network, no key
*/
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* ---------- confidence ---------- */

/* Ordered weakest to strongest. A combined estimate takes the WEAKEST confidence of the rates it
   used, because a chain is exactly as trustworthy as its worst link. 'user' outranks 'high' on
   purpose: someone who pinned their own rate knows their own billing tier better than this file
   ever will, and their number must not be labelled an estimate. */
const CONF_RANK = { unknown: 0, low: 1, medium: 2, 'medium-high': 3, high: 4, user: 5 }
const weakest = (a, b) => (CONF_RANK[a] <= CONF_RANK[b] ? a : b)

/* ---------- the rate table ---------- */

/* Flat, dotted keys. Nesting reads nicer but this shape is what makes overrides and calibration
   simple: an override names a key, and calibrate() can hand back the exact key to pin.

   Every entry carries source / checked / confidence because a rate without provenance is how this
   repo's reference doc ended up claiming "Verified August 2026" over contracts that were wrong.

   `caveat` prints on the one-line cost figure, so it is reserved for something the reader must
   weigh before answering y/n. `note` prints only in the full table - true, useful, and not worth
   crowding a prompt with.

   low/high are in CREDITS per `unit`, except creditUsd which is USD per credit. */
const entry = (o) => Object.freeze({ caveat: '', note: '', known: true, ...o })

export const RATES = Object.freeze({
  /* Read from https://kie.ai/pricing, which states it twice in its own copy: "Each credit is
     valued at $0.005 USD." and "Exchange: 1 cr = $0.005". It also matches what the account holder
     paid ($5 = 1000 credits), and every per-model quote below carries credits and dollars side by
     side at exactly this ratio - three independent agreements, which is why this is the one row
     everything else is allowed to lean on. */
  creditUsd: entry({
    key: 'creditUsd', unit: 'usd-per-credit', low: 0.005, high: 0.005,
    source: 'https://kie.ai/pricing - "Each credit is valued at $0.005 USD"; matches the account ' +
      "holder's $5 = 1000 credits top-up and every per-model quote on the site",
    checked: '2026-08-07', confidence: 'high',
    /* Not a caveat: it cannot make the credit figures wrong, only the dollars conservative. */
    note: 'kie.ai says some top-up SKUs carry 5% or 10% bonus credits, so an effective price can ' +
      'be up to ~10% below $0.005. Credits consumed are exact either way; the USD here is the ' +
      'standard rate and therefore an upper bound. Pin creditUsd if you are on a bonus SKU.',
  }),

  /* GPT Image 2, per image. Read from https://kie.ai/gpt-image-2, which carries the same line for
     both gpt-image-2-text-to-image and gpt-image-2-image-to-image - the second being the exact
     model string keyframes.mjs sends:
       "GPT-2 Image - now just 6 credits ($0.03) for 1 K, 10 credits ($0.05) for 2 K,
        and 16 credits ($0.08) for 4 K." */
  'image.1K': entry({
    key: 'image.1K', unit: 'image', low: 6, high: 6,
    source: 'https://kie.ai/gpt-image-2 - "6 credits ($0.03) for 1 K"',
    checked: '2026-08-07', confidence: 'high',
  }),
  'image.2K': entry({
    key: 'image.2K', unit: 'image', low: 10, high: 10,
    source: 'https://kie.ai/gpt-image-2 - "10 credits ($0.05) for 2 K"',
    checked: '2026-08-07', confidence: 'high',
  }),
  'image.4K': entry({
    key: 'image.4K', unit: 'image', low: 16, high: 16,
    source: 'https://kie.ai/gpt-image-2 - "16 credits ($0.08) for 4 K"',
    checked: '2026-08-07', confidence: 'high',
  }),

  /* Kling 3.0, per second of finished video. Read from https://kie.ai/kling-3-0, verbatim:
       "Standard: no-audio 14 credits ($0.07) /s ; with audio 20 credits ($0.1)/s;
        Pro: no-audio 18 credits ($0.09) / s; with audio 27 credits ($0.135)/s
        4K: no/with audio 67 credits ($0.335) /s"

     Two traps live in those three lines.

     The first is the audio column. tween.mjs sends `sound: false`, so the no-audio numbers are the
     right ones - but they are the CHEAPER ones, and a future change that turns sound on would make
     every estimate here understate the real bill by a third at pro (18 -> 27 cr/s, i.e. you pay
     50% more than the quote) and by 30% at std (14 -> 20, a 43% uplift), without anything failing.
     State the direction: 27 is 1.5x of 18, 18 is 0.67x of 27, and quoting a figure derivable from
     neither pairing was itself a defect here. That is why the audio rates are recorded, not dropped.

     The second is 4K, and it is the expensive one. 67 credits/s is 3.7x pro, so a six-step
     storyboard - five 5s segments, 25s of video - goes from ~$2.25 to ~$8.38 on that flag alone.
     This was an unpriced mode until the rate above was read; a gate that could not name that
     number was the gate most worth fixing. */
  'video.std': entry({
    key: 'video.std', unit: 'second', low: 14, high: 14,
    source: 'https://kie.ai/kling-3-0 - "Standard: no-audio 14 credits ($0.07) /s"',
    checked: '2026-08-07', confidence: 'high',
    note: 'with audio, kie.ai quotes 20 credits ($0.10)/s. tween.mjs sends sound:false.',
  }),
  'video.pro': entry({
    key: 'video.pro', unit: 'second', low: 18, high: 18,
    source: 'https://kie.ai/kling-3-0 - "Pro: no-audio 18 credits ($0.09) / s"',
    checked: '2026-08-07', confidence: 'high',
    note: 'with audio, kie.ai quotes 27 credits ($0.135)/s. tween.mjs sends sound:false.',
  }),
  'video.4K': entry({
    key: 'video.4K', unit: 'second', low: 67, high: 67,
    source: 'https://kie.ai/kling-3-0 - "4K: no/with audio 67 credits ($0.335) /s"',
    checked: '2026-08-07', confidence: 'high',
    note: '3.7x the pro rate, and the same with or without audio. On a six-step storyboard that ' +
      'one flag takes the run from ~$2.55 to ~$8.70.',
  }),

  /* GPT 5.6 Sol, one storyboard call. The only DERIVED row in the table, and the widest.

     kie.ai's per-token rates are quoted plainly (https://kie.ai/gpt-5-6):
       Input 280 credits / 1M tokens, Output 1680 credits / 1M tokens.
     What is not published is how many tokens a storyboard costs. One measured run came to ~3-4k
     tokens total, and the split between input and output was not recorded - which matters, because
     output is 6x input and Sol is a reasoning model, so reasoning tokens land in the output column.

     So the honest bound is the whole envelope, not a point:
       floor    3000 tokens, all input   = 3000 x 280 / 1e6  = 0.84 credits (~$0.004)
       ceiling  4000 tokens, all output  = 4000 x 1680 / 1e6 = 6.72 credits (~$0.034)

     Worth stating plainly, because the brief this was built from said "under a cent": at kie.ai's
     published Sol rates that is only true at the input-heavy end of the envelope. It is still
     ~1% of a typical run, but the way to say so is a range, not a rounded-down claim. */
  'sol.call': entry({
    key: 'sol.call', unit: 'call', low: 0.84, high: 6.72,
    source: 'derived: https://kie.ai/gpt-5-6 quotes gpt-5-6-sol at 280 credits/1M input tokens and ' +
      '1680 credits/1M output tokens; one measured storyboard run used ~3-4k tokens total with an ' +
      'unrecorded split, so this is 3k all-input to 4k all-output',
    checked: '2026-08-07', confidence: 'medium',
    caveat: 'the Sol figure is a token-count bound, not a quoted per-call rate',
    note: 'cached input is 28 and cache writes 350 credits/1M tokens; neither applies to a ' +
      'single cold storyboard call.',
  }),
})

/* ---------- overrides ---------- */

/* Somebody on a discounted top-up tier should not be stuck with our numbers, and should not have
   to edit this file to escape them.

   PRECEDENCE, strongest first. Each tier fills in only the keys it names, so pinning one rate
   leaves the rest of the table alone:

     1. a `rates` object handed straight to an estimate function   (a caller that already loaded one)
     2. SSH_RATES         inline JSON in the environment, set per shell or per run
     3. SSH_RATES_FILE    path to a JSON file
     4. ./ssh-rates.json  in the working directory, if it exists
     5. the built-in table above

   SSH_RATES beats the file deliberately: the file is a standing default someone set months ago,
   the env var is what they typed for this run.

   The JSON accepts nested or dotted keys, and a value may be a bare number, a [low, high] pair,
   or {low, high} / {credits}:

     {"creditUsd": 0.004, "image": {"2K": 8}, "video": {"pro": 6.2, "std": [5.8, 6.4]}}
     {"video.4K": 40}

   A malformed override is NOT silently dropped and NOT fatal. It is recorded in .problems and
   printed once, because a user who pinned a rate did so precisely because ours is wrong for them;
   quietly reverting to ours would price their run at a number they had already rejected. */

const OVERRIDE_ENV = 'SSH_RATES'
const OVERRIDE_FILE_ENV = 'SSH_RATES_FILE'
const OVERRIDE_FILE_DEFAULT = 'ssh-rates.json'

/* {"video": {"pro": 6.2}} and {"video.pro": 6.2} have to mean the same thing, so flatten first. */
function flattenKeys (obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        v.low === undefined && v.high === undefined && v.credits === undefined) {
      flattenKeys(v, key, out)
    } else {
      out[key] = v
    }
  }
  return out
}

/* One override value -> {low, high}, or null if it is not a rate at all.

   There is deliberately no {"usd": n} form. Every row except creditUsd is denominated in CREDITS,
   so accepting a "usd" key would let {"video":{"pro":{"usd":0.09}}} - which is the correct dollar
   figure - be read as 0.09 CREDITS per second and price a run at 1/200th of its real cost. A
   rejected key prints a message; a silently misread one prints a wrong number, which is worse. */
function readRate (v) {
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
  if (typeof v === 'number') { const n = num(v); return n === null ? null : { low: n, high: n } }
  if (Array.isArray(v)) {
    const lo = num(v[0]); const hi = num(v.length > 1 ? v[1] : v[0])
    if (lo === null || hi === null) return null
    return { low: Math.min(lo, hi), high: Math.max(lo, hi) }
  }
  if (v && typeof v === 'object') {
    if (v.credits !== undefined) return readRate(v.credits)
    const lo = num(v.low); const hi = num(v.high !== undefined ? v.high : v.low)
    if (lo === null || hi === null) return null
    return { low: Math.min(lo, hi), high: Math.max(lo, hi) }
  }
  return null
}

function applyOverrides (entries, raw, where, overrides, problems) {
  let flat
  try {
    flat = flattenKeys(raw, '', Object.create(null))
  } catch (e) {
    problems.push(`${where}: could not be read (${e.message}); built-in rates used instead`)
    return
  }
  for (const [key, value] of Object.entries(flat)) {
    if (!Object.prototype.hasOwnProperty.call(RATES, key)) {
      /* The likeliest wrong key is not a typo, it is a unit: someone writing what they were
         charged in dollars under a row that is denominated in credits. Name that specifically,
         because "unknown key" would send them looking for a spelling mistake. */
      const parent = key.replace(/\.(usd|dollars|price)$/i, '')
      if (parent !== key && Object.prototype.hasOwnProperty.call(RATES, parent)) {
        problems.push(`${where}: "${key}" - ${parent} is denominated in CREDITS, not dollars. ` +
          `Write {"${parent}": <credits>} and let creditUsd do the conversion.`)
        continue
      }
      problems.push(`${where}: "${key}" is not a rate this pipeline uses; ignored. ` +
        `Known keys: ${Object.keys(RATES).join(', ')}`)
      continue
    }
    const r = readRate(value)
    if (!r) {
      problems.push(`${where}: "${key}" must be a number, [low, high] or {low, high}; ` +
        `got ${JSON.stringify(value)}. Built-in rate used instead.`)
      continue
    }
    /* creditUsd is the one row denominated in DOLLARS, and the natural way to get it wrong is to
       write the number of credits a dollar buys (200) instead of what a credit costs (0.005).
       That inversion multiplies every dollar figure in the run by 40,000, so it is caught here
       rather than printed. Nothing legitimate sits above $1 per credit. */
    if (key === 'creditUsd' && r.high >= 1) {
      problems.push(`${where}: creditUsd is DOLLARS PER CREDIT (e.g. 0.005), got ${r.high}. ` +
        'That looks like credits-per-dollar inverted. Built-in rate used instead.')
      continue
    }
    entries[key] = {
      ...RATES[key], low: r.low, high: r.high, known: true, confidence: 'user', caveat: '',
      source: `pinned by you via ${where}`, checked: 'this run', overridden: true,
    }
    overrides.push(key)
  }
}

let cachedTable = null

/* Returns { entries, overrides, problems } - the "rate table" every other function here takes.
   Cached only for the zero-argument call, which is the one every default parameter makes; pass
   an env or cwd explicitly (the self-test does) and you always get a fresh read. */
export function loadRates ({ env = null, cwd = null, quiet = false, force = false } = {}) {
  const useCache = !env && !cwd && !force
  if (useCache && cachedTable) return cachedTable

  const e = env || process.env
  const dir = cwd || process.cwd()
  const entries = Object.create(null)
  for (const [k, v] of Object.entries(RATES)) entries[k] = { ...v }
  const overrides = []
  const problems = []

  /* Weakest tier first, so the stronger ones overwrite it. */
  const tiers = []
  const localFile = path.resolve(dir, OVERRIDE_FILE_DEFAULT)
  if (fs.existsSync(localFile)) tiers.push([localFile, `./${OVERRIDE_FILE_DEFAULT}`])
  if (e[OVERRIDE_FILE_ENV]) tiers.push([path.resolve(dir, e[OVERRIDE_FILE_ENV]), OVERRIDE_FILE_ENV])
  for (const [file, where] of tiers) {
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
      problems.push(`${where} (${file}) is not readable JSON (${err.message}); built-in rates used instead`)
      continue
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${where} (${file}) must contain a JSON object; built-in rates used instead`)
      continue
    }
    applyOverrides(entries, raw, where, overrides, problems)
  }
  if (e[OVERRIDE_ENV]) {
    let raw = null
    try {
      raw = JSON.parse(e[OVERRIDE_ENV])
    } catch (err) {
      problems.push(`${OVERRIDE_ENV} is not valid JSON (${err.message}); built-in rates used instead`)
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      applyOverrides(entries, raw, OVERRIDE_ENV, overrides, problems)
    } else if (raw !== null) {
      problems.push(`${OVERRIDE_ENV} must be a JSON object; built-in rates used instead`)
    }
  }

  const table = { entries, overrides, problems }
  /* Once, and to stderr, so it lands above a y/n prompt rather than inside a cost figure. */
  if (!quiet && problems.length) for (const p of problems) console.error(`  rate override ignored - ${p}`)
  if (useCache) cachedTable = table
  return table
}

const rateOf = (rates, key) => (rates && rates.entries ? rates.entries[key] : undefined)

/* ---------- estimates ---------- */

/* THE ESTIMATE OBJECT. Every estimate function returns this shape and nothing else; the caller
   formats it. Two callers already want different layouts, so returning a rendered string here
   would only mean one of them re-parsing it.

     kind        'keyframes' | 'tween' | 'storyboard' | 'run'
     known       false when no rate exists for the request; credits and usd are then null
     negligible  DERIVED, not declared: the whole range lands under a cent, so "under a cent" is
                 the accurate thing to print. Computed from the numbers so it cannot go stale the
                 way a hand-set flag on a rate row would
     partial     run only: at least one part was unknown, so the total is a floor
     pinned      at least one rate used came from the user's own override
     credits     {low, high} | null
     usd         {low, high} | null
     basis       what was multiplied, in words - "12 images at 2K x 10 credits"
     confidence  weakest confidence of the rates used
     caveat      one short clause for the weakest rate, '' when there is nothing to say
     caveats     every distinct caveat, for a caller with room for more than one line
     rate        {key, unit, units, creditsPerUnit:{low,high}} | null - what calibrate() measures against
     parts       run only: the child estimates, in print order
     reason      why it is unknown, '' otherwise */
function mkEstimate (o) {
  return {
    kind: o.kind,
    known: o.known !== false,
    negligible: !!(o.usd && o.usd.high > 0 && o.usd.high < 0.01),
    partial: !!o.partial,
    pinned: !!o.pinned,
    credits: o.credits || null,
    usd: o.usd || null,
    basis: o.basis || '',
    confidence: o.confidence || 'unknown',
    caveat: o.caveat || '',
    caveats: o.caveats || (o.caveat ? [o.caveat] : []),
    rate: o.rate || null,
    parts: o.parts || [],
    reason: o.reason || '',
  }
}

/* units x one rate -> an estimate. The USD range multiplies low by low and high by high so a
   pinned conversion range widens the dollars the way it should. */
function fromEntry (kind, e, units, basis, rates, extra = {}) {
  const cu = rateOf(rates, 'creditUsd')
  const credits = { low: e.low * units, high: e.high * units }
  return mkEstimate({
    kind,
    credits,
    usd: { low: credits.low * cu.low, high: credits.high * cu.high },
    basis,
    confidence: weakest(e.confidence, cu.confidence),
    caveat: e.caveat,
    pinned: !!e.overridden || !!cu.overridden,
    rate: { key: e.key, unit: e.unit, units, creditsPerUnit: { low: e.low, high: e.high } },
    ...extra,
  })
}

const unknownEstimate = (kind, reason) => mkEstimate({ kind, known: false, reason, confidence: 'unknown' })

const whole = (n) => Math.max(0, Math.floor(Number(n) || 0))

/* The valid suffixes, read off the table rather than written out again, so adding a row cannot
   leave an error message advertising a shorter list than the code accepts. */
const variantsOf = (group) => Object.keys(RATES)
  .filter(k => k.startsWith(group + '.')).map(k => k.slice(group.length + 1)).join(', ')

/* N stills at one resolution. `count` is what will ACTUALLY be generated - keyframes.mjs skips the
   last frame when the user supplied a real "after" photo, and only the caller knows that. */
export function estimateKeyframes ({ count = 0, resolution = '2K', rates = loadRates() } = {}) {
  const n = whole(count)
  const e = rateOf(rates, `image.${resolution}`)
  if (!e) {
    return unknownEstimate('keyframes',
      `no rate for GPT Image 2 at ${resolution} (known: ${variantsOf('image')})`)
  }
  if (!e.known) {
    return unknownEstimate('keyframes', `the GPT Image 2 ${resolution} rate is unknown, so ` +
      `${n} still${n === 1 ? '' : 's'} cannot be priced here`)
  }
  return fromEntry('keyframes', e, n,
    `${n} image${n === 1 ? '' : 's'} at ${resolution}, ${creditsPerUnit(e)}`, rates)
}

/* N segments of `seconds` each. Kling bills per second of finished video, so this is
   segments x seconds x rate. Note what it does NOT charge for: build-frames.mjs throws away most
   of the frames in every clip (see tween.mjs's cost line), and those are paid for regardless -
   the length billed is the length ordered, not the length used. */
export function estimateTween ({ segments = 0, seconds = 5, mode = 'pro', rates = loadRates() } = {}) {
  const n = whole(segments)
  const secs = Number(seconds) || 0
  const e = rateOf(rates, `video.${mode}`)
  if (!e) {
    return unknownEstimate('tween',
      `no rate for Kling 3.0 in ${mode} mode (known: ${variantsOf('video')})`)
  }
  if (!e.known) {
    return unknownEstimate('tween',
      `the Kling ${mode} rate is unknown, so ${n} x ${secs}s of video cannot be priced here`)
  }
  const units = n * secs
  return fromEntry('tween', e, units,
    `${n} segment${n === 1 ? '' : 's'} x ${secs}s at ${mode} = ${units}s, ${creditsPerUnit(e)}`, rates)
}

/* One Sol call. Deliberately incapable of returning a precise figure - see the sol.call row. */
export function estimateStoryboard ({ calls = 1, rates = loadRates() } = {}) {
  const n = whole(calls)
  const e = rateOf(rates, 'sol.call')
  return fromEntry('storyboard', e, n,
    `${n} GPT 5.6 Sol call${n === 1 ? '' : 's'}, text only`, rates)
}

/* The whole run, for the interview stage - before anything has been generated and while the
   answer can still change what gets ordered. Mirrors what the three scripts will actually do:
   one Sol call, one still per step (minus the supplied "after" photo, if there is one), and one
   video segment per gap between steps. */
export function estimateRun ({
  steps = 0, seconds = 5, mode = 'pro', resolution = '2K', realAfter = false, rates = loadRates(),
} = {}) {
  const n = whole(steps)
  const parts = [
    estimateStoryboard({ rates }),
    estimateKeyframes({ count: Math.max(0, n - (realAfter ? 1 : 0)), resolution, rates }),
    estimateTween({ segments: Math.max(0, n - 1), seconds, mode, rates }),
  ]
  return combine(parts, {
    kind: 'run',
    basis: `${n} step${n === 1 ? '' : 's'} -> ${Math.max(0, n - 1)} segment${n === 2 ? '' : 's'} ` +
      `(${resolution} stills, ${mode} video at ${seconds}s)`,
  })
}

/* Sum a set of estimates, keeping the weakest confidence and flagging anything that could not be
   priced. A total that silently omitted an unpriceable part would be the exact failure this file
   exists to prevent, so the omission is carried as `partial` and named in `reason`. */
export function combine (parts, { kind = 'run', basis = '' } = {}) {
  const known = parts.filter(p => p.known)
  const missing = parts.filter(p => !p.known)
  if (!known.length) {
    return mkEstimate({
      kind, known: false, parts,
      reason: missing.map(p => p.reason).join('; ') || 'nothing to price',
    })
  }
  const credits = { low: 0, high: 0 }
  const usd = { low: 0, high: 0 }
  let confidence = 'user'
  for (const p of known) {
    credits.low += p.credits.low; credits.high += p.credits.high
    usd.low += p.usd.low; usd.high += p.usd.high
    confidence = weakest(confidence, p.confidence)
  }
  /* One clause, from the weakest rate that has something to say AND is big enough to matter - this
     prints above a y/n prompt that people have to actually read. The Sol line is the reason for the
     materiality test: it is the least certain number in the table and about 1% of a typical run, so
     hanging its caveat off the grand total would spend the reader's attention on a rounding error
     and train them to skip the line where the real warning will one day appear. Nothing is hidden -
     every caveat is still on .caveats, and formatBreakdown prints each on its own stage. */
  const caveats = [...new Set(known.filter(p => p.caveat).map(p => p.caveat))]
  const MATERIAL = 0.1
  const weakestPart = known
    .filter(p => p.caveat && credits.high > 0 && p.credits.high / credits.high >= MATERIAL)
    .sort((a, b) => CONF_RANK[a.confidence] - CONF_RANK[b.confidence])[0]
  return mkEstimate({
    kind, credits, usd, basis, confidence,
    caveat: weakestPart ? weakestPart.caveat : '',
    caveats,
    pinned: known.some(p => p.pinned),
    partial: missing.length > 0,
    reason: missing.map(p => p.reason).join('; '),
    parts,
  })
}

/* ---------- formatting ---------- */

/* One formatter, used by every caller, so the cost line reads the same everywhere.

   Rounding is display-only; the estimate objects keep full precision so calibrate() is not
   comparing against a rounded prediction. */
const fmtCredits = (n) => Math.round(n).toLocaleString('en-US')
const fmtUsd = (n) => (n > 0 && n < 0.01 ? '<$0.01' : '$' + n.toFixed(2))
const creditsPerUnit = (e) =>
  (e.low === e.high ? `${e.low} credits/${e.unit}` : `${e.low}-${e.high} credits/${e.unit}`)

function rangeStr (r, fmt) {
  const lo = fmt(r.low); const hi = fmt(r.high)
  return lo === hi ? lo : `${lo}-${hi}`
}

/* Both ends at the same precision, chosen so the LOW end is still a number. Two decimals would
   print the Sol range as "$0.00-$0.03", and a leading $0.00 is the one rendering that makes a real
   charge look like no charge. */
function usdRange (u) {
  const dp = u.low > 0 && u.low < 0.01 ? 3 : 2
  const lo = '$' + u.low.toFixed(dp)
  const hi = '$' + u.high.toFixed(dp)
  return lo === hi ? lo : `${lo}-${hi}`
}

/* The cost line. "~630 credits (~$3.15)", or with a range, or with the one clause that says why
   the number is soft. `caveat: false` suppresses the clause for a caller that prints it itself. */
export function formatCost (est, { prefix = '', caveat = true } = {}) {
  if (!est) return `${prefix}cost unknown`
  const tail = caveat && est.caveat ? ` - ${est.caveat}` : ''
  if (!est.known) return `${prefix}cost unknown - ${est.reason}`
  if (est.negligible) {
    /* Not "free", and not "$0.00". A fraction of a cent is still a charge, and printing zero next
       to a real bill teaches people to stop reading the line. */
    return `${prefix}under a cent${tail}`
  }
  const body = `~${rangeStr(est.credits, fmtCredits)} credits (~${usdRange(est.usd)})`
  const floor = est.partial ? 'at least ' : ''
  const short = est.partial && est.reason ? ` - excludes: ${est.reason}` : ''
  return `${prefix}${floor}${body}${tail}${short}`
}

/* A run, broken out one line per stage, for the interview gate that has room for it. Returns an
   array of lines; the caller decides on indentation and where it sits. */
export function formatBreakdown (run, { label = 'total' } = {}) {
  const name = { storyboard: 'storyboard', keyframes: 'keyframes', tween: 'video' }
  const lines = []
  for (const p of run.parts || []) {
    const tag = (name[p.kind] || p.kind).padEnd(11)
    lines.push(`${tag}${formatCost(p)}${p.pinned ? '  (your pinned rate)' : ''}`)
  }
  lines.push(`${label.padEnd(11)}${formatCost(run)}`)
  return lines
}

/* The rate table itself, with provenance, for `node pricing.mjs` and for doctor-style output. */
export function formatRates (rates = loadRates()) {
  const lines = []
  for (const key of Object.keys(RATES)) {
    const e = rates.entries[key]
    const value = key === 'creditUsd'
      ? `$${e.low} per credit`
      : (e.known ? creditsPerUnit(e) : 'UNKNOWN')
    lines.push(`${key.padEnd(12)} ${String(value).padEnd(22)} ${e.confidence}${e.overridden ? ' (pinned)' : ''}`)
    /* Wrapped, because this is the output a human reads in a terminal and a source line naming a
       URL and a quote does not fit one. The cost lines elsewhere are short by construction. */
    field(lines, 'source', e.source)
    field(lines, 'checked', e.checked)
    field(lines, 'caveat', e.caveat)
    field(lines, 'note', e.note)
  }
  return lines
}

/* One labelled, wrapped field. The label appears once; continuations line up under it. */
function field (lines, label, text, width = 88) {
  if (!text) return
  const pad = '             '
  const head = `${label}: `
  const wrapped = []
  let line = ''
  for (const word of String(text).split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) { wrapped.push(line); line = word } else line = line ? line + ' ' + word : word
  }
  if (line) wrapped.push(line)
  wrapped.forEach((l, i) => lines.push(pad + (i ? ' '.repeat(head.length) : head) + l))
}

/* ---------- balance ---------- */

/* GET /api/v1/chat/credit -> credits remaining on the account.

   The route was probed unauthenticated on 2026-08-07 and it EXISTS: it answered HTTP 200 with a
   body code of 401, which is kie.ai's way of saying "route is here, credentials are not". The
   control matters as much as the probe - /api/v1/common/credit answered a real HTTP 404, so the
   401 above is a signal rather than a catch-all.

   What was NOT verified is the shape of the success body, because reading it needs a key. So the
   parser below accepts a bare number at `data` or any of several field names, and when it
   recognises none of them it says "balance unknown" rather than guessing. An invented balance
   would be worse than no balance. (`remainingCredits` leads the list because that is the string
   kie.ai's own dashboard uses for this figure - seen in the page copy on the same date. That is a
   hint about their vocabulary, not a verified field name, which is why the others stay.)

   FAILS SOFT, ALWAYS. This function cannot throw. A balance lookup exists to inform a spend gate;
   the day it starts blocking one - because the network is down, or a proxy answered HTML, or
   kie.ai renamed the field - it has become a liability. Every failure degrades to
   {known:false, reason}.

   ON NOT REUSING kie.mjs: the right home for this request is kie.mjs's req(), which owns the
   timeout, the retry policy and the code-inside-a-200 unwrapping. req() is module-private and this
   file may not edit kie.mjs, so the request is made here through a SEAM instead: pass `fetchImpl`
   and this delegates. The day kie.mjs exports a generic JSON getter, the default below becomes a
   one-line call to it and nothing else in this file changes. See the report note.

   Retry is deliberately absent even so. Everything req() retries would, here, make a gate wait
   through several backoffs for a number it is allowed not to have. One attempt, short deadline,
   degrade. */
const BALANCE_URL = 'https://api.kie.ai/api/v1/chat/credit'
const BALANCE_TIMEOUT_MS = 8000
const BALANCE_FIELDS = ['remainingCredits', 'credits', 'credit', 'balance', 'remaining', 'quantity', 'amount']

export async function fetchBalance ({
  apiKey = process.env.KIE_API_KEY,
  timeoutMs = BALANCE_TIMEOUT_MS,
  fetchImpl = null,
  url = BALANCE_URL,
  rates = null,
} = {}) {
  const unknown = (reason) => ({ known: false, credits: null, usd: null, reason })
  try {
    if (!apiKey) return unknown('KIE_API_KEY is not set')
    const doFetch = fetchImpl || globalThis.fetch
    if (typeof doFetch !== 'function') return unknown('this Node has no fetch')

    const res = await doFetch(url, {
      headers: {
        /* The key goes on the wire and nowhere else. Nothing below ever puts it in a message. */
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let body = null
    try { body = JSON.parse(text) } catch (_) {}
    if (!body) {
      return unknown(res.ok
        ? `kie.ai answered HTTP ${res.status} but not JSON`
        : `kie.ai answered HTTP ${res.status}`)
    }
    /* Same quirk as everywhere else in this API: a non-200 code can arrive inside an HTTP 200. */
    if (body.code !== undefined && String(body.code) !== '200') {
      return unknown(`kie.ai answered code ${body.code}${body.msg ? ' - ' + body.msg : ''}`)
    }
    if (!res.ok) return unknown(`kie.ai answered HTTP ${res.status}`)

    const d = body.data
    let credits = null
    if (typeof d === 'number') credits = d
    else if (d && typeof d === 'object') {
      for (const f of BALANCE_FIELDS) {
        if (typeof d[f] === 'number') { credits = d[f]; break }
        /* Some kie.ai fields arrive as numeric strings; accept those, reject anything else. */
        if (typeof d[f] === 'string' && d[f].trim() && Number.isFinite(Number(d[f]))) { credits = Number(d[f]); break }
      }
    } else if (typeof body.credits === 'number') credits = body.credits

    if (!Number.isFinite(credits)) {
      return unknown('kie.ai answered, but no credit figure was recognised in the response')
    }
    const cu = rateOf(rates || loadRates(), 'creditUsd')
    return { known: true, credits, usd: credits * cu.low, reason: '' }
  } catch (e) {
    /* Includes AbortSignal.timeout, DNS failure, TLS failure and anything undici invents. */
    return unknown(`balance lookup failed (${(e && e.message) || e})`)
  }
}

/* One line. If an estimate is supplied and the balance cannot cover its HIGH end, say so - the
   high end is the right one to check against, because running out mid-run leaves paid-for
   fragments and no hero. */
export function formatBalance (bal, est = null) {
  if (!bal || !bal.known) return `balance unknown (${(bal && bal.reason) || 'not looked up'})`
  const line = `balance ${fmtCredits(bal.credits)} credits (~${fmtUsd(bal.usd)})`
  if (!est || !est.known || !est.credits) return line
  if (bal.credits < est.credits.high) {
    return `${line} - NOT enough for this run, which needs up to ~${fmtCredits(est.credits.high)}`
  }
  /* A partial estimate is a FLOOR - something in the run had no rate, so credits.high is short of
     the real bill by an unknown amount. Silence here would read as "you have enough", which is a
     confident claim the numbers cannot support. Three callers guarded this by hand and the fourth
     forgot, so the guard belongs here where it cannot be omitted. */
  if (est.partial) {
    return `${line} - covers the ~${fmtCredits(est.credits.high)} that could be priced, but part ` +
      'of this run has no rate, so the real total is higher by an unknown amount'
  }
  return line
}

/* ---------- calibration ---------- */

/* The part that makes the table honest over time.

   tween.mjs already persists kie.ai's reported creditsConsumed per segment into
   segments/_state.json. That is ground truth and this table is not. Feed the two to calibrate()
   and it says whether the prediction held, and when it did not, it names the measured rate in a
   form that can be pinned.

   `observed` may be a number (total credits), an array of per-item credits, or
   {credits, units} - the last being the only one that can yield a per-unit rate, which is why
   observedFromSegments() below exists to build it.

   The comparison is against the NEAREST EDGE of the estimate range, not its midpoint. A range is
   a claim that the truth lies inside it; an observation inside the range is not "7% off the
   middle", it is correct. */
export function calibrate (estimate, observed, { tolerance = 0.15, rates = null } = {}) {
  const out = {
    ok: false, within: null, tolerance,
    unit: estimate && estimate.rate ? estimate.rate.unit : null,
    observed: { credits: null, units: null, perUnit: null },
    estimated: { credits: null, perUnit: null },
    delta: { credits: null, ratio: null, pct: null },
    suggestion: null,
    reason: '',
  }
  if (!estimate || !estimate.known || !estimate.credits) {
    out.reason = 'nothing to compare against - the estimate had no rate'
    return out
  }

  let credits = null
  let units = null
  if (typeof observed === 'number') credits = observed
  else if (Array.isArray(observed)) {
    const nums = observed.filter(n => Number.isFinite(Number(n))).map(Number)
    if (nums.length) credits = nums.reduce((a, b) => a + b, 0)
  } else if (observed && typeof observed === 'object') {
    if (Number.isFinite(Number(observed.credits))) credits = Number(observed.credits)
    if (Number.isFinite(Number(observed.units))) units = Number(observed.units)
  }
  if (!Number.isFinite(credits)) {
    out.reason = 'no observed creditsConsumed to compare - kie.ai reported none for this run'
    return out
  }
  /* Falling back to the estimate's own unit count assumes the observation covers the whole
     estimate. It does for the caller this was built for (tween.mjs sums the segments it just
     paid for and estimated), and a caller measuring a subset should pass units explicitly. */
  if (!Number.isFinite(units) && estimate.rate) units = estimate.rate.units

  const est = estimate.credits
  out.ok = true
  out.observed.credits = credits
  out.observed.units = Number.isFinite(units) && units > 0 ? units : null
  out.observed.perUnit = out.observed.units ? credits / out.observed.units : null
  out.estimated.credits = { low: est.low, high: est.high }
  out.estimated.perUnit = estimate.rate ? estimate.rate.creditsPerUnit : null

  /* Distance to the nearest edge, signed: negative means the real bill came in under the table. */
  let diff = 0
  let edge = est.low
  if (credits > est.high) { diff = credits - est.high; edge = est.high } else if (credits < est.low) { diff = credits - est.low; edge = est.low }
  const ratio = edge > 0 ? diff / edge : (diff === 0 ? 0 : Infinity)
  out.delta.credits = diff
  out.delta.ratio = ratio
  out.delta.pct = Number.isFinite(ratio) ? ratio * 100 : null
  out.within = Math.abs(ratio) <= tolerance

  /* Only worth suggesting a replacement rate when there is a per-unit figure to replace it with
     and the table is actually off. Rounded to three significant-ish decimals: more digits would
     imply the measurement is finer than one run can support. */
  if (!out.within && out.observed.perUnit !== null && estimate.rate) {
    const perUnit = Math.round(out.observed.perUnit * 1000) / 1000
    /* The dollar figure has to go through the SAME conversion the rest of the run used, pinned or
       not - quoting a measured rate in someone else's dollars would undo the point of measuring. */
    const cu = rateOf(rates || loadRates(), 'creditUsd')
    out.suggestion = {
      key: estimate.rate.key,
      unit: estimate.rate.unit,
      creditsPerUnit: perUnit,
      usdPerUnit: perUnit * cu.low,
      json: JSON.stringify({ [estimate.rate.key]: perUnit }),
    }
  }
  return out
}

/* Pull the ground truth out of tween.mjs's segments/_state.json shape:
     { segments: { "3": { creditsConsumed: 90, duration: 5, mode: "pro", ... } } }
   Returns {credits, units, segments, modes} where `units` is SECONDS, because that is the unit
   the video rate is quoted in and getting it wrong is how a calibration reports a 5x error.
   `only` restricts it to the segments a run actually paid for this time, which is not the same
   set as the ones state has a figure for. */
export function observedFromSegments (segmentsMap, { only = null } = {}) {
  const out = { credits: 0, units: 0, segments: 0, modes: [] }
  for (const [id, s] of Object.entries(segmentsMap || {})) {
    if (only && !only.map(String).includes(String(id))) continue
    const c = Number(s && s.creditsConsumed)
    if (!Number.isFinite(c)) continue
    out.credits += c
    out.segments += 1
    const d = Number(s.duration)
    if (Number.isFinite(d)) out.units += d
    if (s.mode && !out.modes.includes(s.mode)) out.modes.push(s.mode)
  }
  if (!out.segments) return { credits: null, units: null, segments: 0, modes: [] }
  return out
}

/* The end-of-run line. Silent (returns []) when there is nothing worth saying, so a caller can
   splice it in unconditionally. */
export function formatCalibration (cal) {
  if (!cal || !cal.ok) return []
  const o = cal.observed
  const measured = o.units !== null && cal.unit
    ? `${fmtCredits(o.credits)} credits for ${o.units} ${cal.unit}${o.units === 1 ? '' : 's'}`
    : `${fmtCredits(o.credits)} credits`
  const est = cal.estimated.credits
  const predicted = est.low === est.high ? `~${fmtCredits(est.low)}` : `~${fmtCredits(est.low)}-${fmtCredits(est.high)}`
  if (cal.within) {
    return [`billed ${measured}; the built-in estimate said ${predicted} credits, so the rate table held.`]
  }
  const dir = cal.delta.credits > 0 ? 'LOW' : 'HIGH'
  const pct = Math.abs(Math.round(cal.delta.pct))
  const lines = [
    `billed ${measured}; the built-in estimate said ${predicted} credits, so the built-in rate is ${pct}% ${dir}.`,
  ]
  if (cal.suggestion) {
    const s = cal.suggestion
    lines.push(`your real rate is ${s.creditsPerUnit} credits/${s.unit} (~$${s.usdPerUnit.toFixed(4)}/${s.unit}). Pin it:`)
    lines.push(`  SSH_RATES=${s.json}        PowerShell:  $env:SSH_RATES='${s.json}'`)
  }
  return lines
}

/* ---------- direct invocation ---------- */

/* Not kie.mjs's args(): this entry point exists for a human checking the table and for the
   self-test, importing the shared parser would drag a repo dependency into a file that is
   deliberately standalone, and two flags do not need a parser. */
const invokedDirectly = (() => {
  try { return !!process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url } catch (_) { return false }
})()

if (invokedDirectly) {
  if (process.argv.includes('--self-test')) await selfTest()
  else {
    const rates = loadRates()
    console.log('\nscroll-scrub-hero rate table\n')
    for (const l of formatRates(rates)) console.log('  ' + l)
    if (rates.overrides.length) console.log(`\n  pinned by you: ${rates.overrides.join(', ')}`)
    const run = estimateRun({ steps: 6, seconds: 5, mode: 'pro', resolution: '2K', rates })
    console.log('\nexample - 6 steps, 2K stills, 5 pro segments of 5s:\n')
    for (const l of formatBreakdown(run)) console.log('  ' + l)
    console.log('\n  Pin your own rates without editing this file:')
    console.log(`    ${OVERRIDE_ENV}='{"video":{"pro":16},"image":{"2K":8}}'`)
    console.log(`    ${OVERRIDE_FILE_ENV}=my-rates.json   or   ./${OVERRIDE_FILE_DEFAULT}\n`)
  }
}

/* The arithmetic, checked offline. No network, no key, no spend - fetchBalance is exercised
   through its injected-fetch seam. Kept in this file rather than in test/ so it travels with the
   table it checks: a rate edited without re-running this is the failure mode worth catching. */
async function selfTest () {
  /* Cases are REGISTERED here and run below, so an async one is awaited rather than counted as a
     pass the instant it returns a pending promise - which is exactly what a naive
     try { fn() } catch harness does to every one of the fetchBalance cases. */
  const tests = []
  const t = (name, fn) => tests.push([name, fn])
  const eq = (a, b, m = '') => {
    if (a !== b) throw new Error(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
  }
  const near = (a, b, m = '', tol = 1e-9) => {
    if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} expected ~${b}, got ${a}`)
  }
  const ok = (c, m) => { if (!c) throw new Error(m) }

  /* An empty directory, so ./ssh-rates.json cannot reach in and change the numbers under test.
     Made rather than assumed: a hard-coded "surely nothing is here" path is a test that passes
     until the day it silently does not. */
  const NOWHERE = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-pricing-'))
  const R = () => loadRates({ env: {}, cwd: NOWHERE, quiet: true })

  t('every rate carries provenance, and a re-runnable one', () => {
    for (const [k, e] of Object.entries(RATES)) {
      ok(e.source && e.source.length > 10, `${k} has no source`)
      ok(/^\d{4}-\d{2}-\d{2}$/.test(e.checked), `${k} has no checked date`)
      ok(e.confidence in CONF_RANK, `${k} has an unknown confidence "${e.confidence}"`)
      /* A date is worth nothing without the page it was read from. Anything claiming 'high' has
         to name a URL somebody else can open. */
      if (e.confidence === 'high') ok(/https:\/\//.test(e.source), `${k} claims high confidence with no URL`)
      if (CONF_RANK[e.confidence] <= CONF_RANK.medium) ok(e.caveat, `${k} is soft but carries no caveat`)
    }
  })

  t('conversion: 1000 credits is $5', () => {
    const e = estimateKeyframes({ count: 100, resolution: '2K', rates: R() })
    eq(e.credits.low, 1000, 'credits')
    near(e.usd.low, 5, 'usd')
  })

  t('keyframes: 6 stills at 2K = 60 credits / $0.30, exact', () => {
    const e = estimateKeyframes({ count: 6, resolution: '2K', rates: R() })
    eq(e.credits.low, 60); eq(e.credits.high, 60)
    near(e.usd.low, 0.30, 'usd')
    eq(formatCost(e), '~60 credits (~$0.30)')
    eq(e.confidence, 'high')
  })

  t('keyframes: 1K and 4K follow kie.ai\'s own quote', () => {
    const r = R()
    near(estimateKeyframes({ count: 1, resolution: '1K', rates: r }).usd.low, 0.03, '1K')
    near(estimateKeyframes({ count: 1, resolution: '4K', rates: r }).usd.low, 0.08, '4K')
  })

  t('keyframes: an unknown resolution is unknown, not zero', () => {
    const e = estimateKeyframes({ count: 6, resolution: '8K', rates: R() })
    eq(e.known, false)
    eq(e.credits, null)
    ok(/no rate for GPT Image 2 at 8K/.test(formatCost(e)), formatCost(e))
  })

  t('tween: std and pro match kie.ai\'s own no-audio quotes', () => {
    const r = R()
    const pro = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: r })
    eq(pro.credits.low, 450); eq(pro.credits.high, 450)
    near(pro.usd.low, 2.25, 'pro usd')          /* 25s x $0.09/s */
    const std = estimateTween({ segments: 5, seconds: 5, mode: 'std', rates: r })
    eq(std.credits.low, 350)
    eq(formatCost(std), '~350 credits (~$1.75)')  /* 25s x $0.07/s, and no caveat now it is sourced */
  })

  t('tween: 4K is priced, and it is the number that changes a decision', () => {
    const e = estimateTween({ segments: 5, seconds: 5, mode: '4K', rates: R() })
    eq(e.known, true)
    eq(e.credits.low, 1675)                      /* 25s x 67 */
    eq(formatCost(e), '~1,675 credits (~$8.38)')
  })

  t('tween: an unknown mode is unknown, not free', () => {
    const e = estimateTween({ segments: 5, seconds: 5, mode: 'ultra', rates: R() })
    eq(e.known, false)
    ok(/no rate for Kling 3.0 in ultra mode/.test(e.reason), e.reason)
    ok(/known: std, pro, 4K/.test(e.reason), 'the list must come off the table: ' + e.reason)
  })

  t('a row the table cannot price stays unpriced rather than counting as zero', () => {
    /* Every built-in row is priced today. This is the path that keeps that from being load-bearing:
       the day a new mode is added without a rate, it must refuse rather than bill it at nothing. */
    const base = R()
    const r = { ...base, entries: { ...base.entries, 'video.pro': { ...base.entries['video.pro'], known: false } } }
    const e = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: r })
    eq(e.known, false)
    eq(e.credits, null, 'an unknown rate must not fall through to 0')
    ok(/the Kling pro rate is unknown/.test(e.reason), e.reason)
    const run = combine([estimateKeyframes({ count: 6, rates: base }), e], { kind: 'run' })
    eq(run.partial, true)
    eq(run.credits.low, 60, 'the total is the priced part only, and says so')
  })

  t('storyboard: an honest token bound, never "free", never a fake figure', () => {
    const e = estimateStoryboard({ rates: R() })
    near(e.credits.low, 0.84, 'floor: 3k tokens all input')
    near(e.credits.high, 6.72, 'ceiling: 4k tokens all output')
    near(e.usd.high, 0.0336, 'ceiling in dollars')
    /* The brief called this "under a cent". At kie.ai's published Sol rates only the floor is. */
    ok(!e.negligible, 'the ceiling is over a cent, so it must not claim otherwise')
    const line = formatCost(e)
    ok(!/free/i.test(line), line)
    ok(!/\$0\.00\b/.test(line), line)
    ok(/token-count bound/.test(line), line)
  })

  t('formatCost: "under a cent" is derived from the numbers, not declared', () => {
    const r = loadRates({ env: { SSH_RATES: '{"sol.call":[0.1,0.5]}' }, cwd: NOWHERE, quiet: true })
    const e = estimateStoryboard({ rates: r })
    ok(e.negligible, 'a 0.5-credit ceiling is a quarter of a cent')
    eq(formatCost(e), 'under a cent')
  })

  t('run: parts sum, and the total takes the weakest confidence of the three', () => {
    const run = estimateRun({ steps: 6, seconds: 5, mode: 'pro', resolution: '2K', rates: R() })
    eq(run.parts.length, 3)
    near(run.credits.low, 0.84 + 60 + 450, 'low')
    near(run.credits.high, 6.72 + 60 + 450, 'high')
    near(run.usd.high, 2.5836, 'usd high')
    eq(run.confidence, 'medium', 'Sol is the softest of the three')
    eq(run.partial, false)
    eq(formatCost(run), '~511-517 credits (~$2.55-$2.58)')
  })

  t('run: a 1%-of-the-bill caveat is kept off the total line, not lost', () => {
    const run = estimateRun({ steps: 6, seconds: 5, mode: 'pro', resolution: '2K', rates: R() })
    eq(run.caveat, '', 'the Sol clause must not ride on the grand total')
    eq(run.caveats.length, 1, 'but it must still be reachable')
    ok(/token-count bound/.test(run.caveats[0]), run.caveats[0])
    ok(/token-count bound/.test(formatBreakdown(run)[0]), 'and printed on its own stage')
  })

  t('run: --mode 4K nearly quadruples the bill, and the total says so', () => {
    const r = R()
    const cheap = estimateRun({ steps: 6, seconds: 5, mode: 'pro', rates: r })
    const dear = estimateRun({ steps: 6, seconds: 5, mode: '4K', rates: r })
    eq(dear.credits.low - cheap.credits.low, 1675 - 450)
    ok(/\$8\.6/.test(formatCost(dear)), formatCost(dear))
  })

  t('run: a real "after" photo means one fewer still', () => {
    const r = R()
    const a = estimateRun({ steps: 6, realAfter: false, rates: r })
    const b = estimateRun({ steps: 6, realAfter: true, rates: r })
    eq(a.credits.low - b.credits.low, 10, 'one 2K still')
  })

  t('run: an unpriceable part makes the total a floor, and names what is missing', () => {
    const run = estimateRun({ steps: 6, resolution: '8K', rates: R() })
    eq(run.partial, true)
    near(run.credits.low, 0.84 + 450, 'Sol and video only')
    const line = formatCost(run)
    ok(/^at least /.test(line), line)
    ok(/excludes:/.test(line), line)
    ok(/8K/.test(line), line)
  })

  t('breakdown: one line per stage plus a total', () => {
    const lines = formatBreakdown(estimateRun({ steps: 6, rates: R() }))
    eq(lines.length, 4)
    ok(/^storyboard /.test(lines[0]), lines[0])
    ok(/^video /.test(lines[2]), lines[2])
    ok(/^total /.test(lines[3]), lines[3])
  })

  t('override: SSH_RATES nested, dotted, and as a range', () => {
    const r = loadRates({
      env: { SSH_RATES: '{"video":{"pro":6},"image.2K":8,"video.std":[4,5]}' },
      cwd: NOWHERE, quiet: true,
    })
    eq(r.problems.length, 0, r.problems.join('; '))
    eq(estimateTween({ segments: 1, seconds: 10, mode: 'pro', rates: r }).credits.low, 60)
    eq(estimateKeyframes({ count: 2, resolution: '2K', rates: r }).credits.low, 16)
    const std = estimateTween({ segments: 1, seconds: 10, mode: 'std', rates: r })
    eq(std.credits.low, 40); eq(std.credits.high, 50)
  })

  t('override: a pinned rate is not labelled an estimate', () => {
    const r = loadRates({ env: { SSH_RATES: '{"video":{"pro":6}}' }, cwd: NOWHERE, quiet: true })
    const e = estimateTween({ segments: 1, seconds: 5, mode: 'pro', rates: r })
    eq(e.caveat, '', 'a rate the user pinned needs no caveat')
    ok(e.pinned, 'not flagged pinned')
    ok(!/estimate/.test(formatCost(e)), formatCost(e))
  })

  t('override: a pinned conversion changes the dollars', () => {
    const r = loadRates({ env: { SSH_RATES: '{"creditUsd":0.004}' }, cwd: NOWHERE, quiet: true })
    near(estimateKeyframes({ count: 100, resolution: '2K', rates: r }).usd.low, 4, 'usd')
  })

  t('override: a discounted tier replaces the built-in rate outright', () => {
    const r = loadRates({ env: { SSH_RATES: '{"video.4K":40}' }, cwd: NOWHERE, quiet: true })
    const e = estimateTween({ segments: 2, seconds: 5, mode: '4K', rates: r })
    eq(e.credits.low, 400, '10s at the pinned 40, not the built-in 67')
    eq(estimateTween({ segments: 2, seconds: 5, mode: '4K', rates: R() }).credits.low, 670)
  })

  t('override: rubbish is reported, not silently obeyed and not fatal', () => {
    const bad = loadRates({ env: { SSH_RATES: 'not json' }, cwd: NOWHERE, quiet: true })
    eq(bad.problems.length, 1)
    eq(bad.entries['video.pro'].low, 18, 'built-in must survive')
    const wrongKey = loadRates({ env: { SSH_RATES: '{"video":{"ultra":9}}' }, cwd: NOWHERE, quiet: true })
    ok(/not a rate this pipeline uses/.test(wrongKey.problems[0]), wrongKey.problems[0])
    const wrongType = loadRates({ env: { SSH_RATES: '{"video":{"pro":"cheap"}}' }, cwd: NOWHERE, quiet: true })
    ok(/must be a number/.test(wrongType.problems[0]), wrongType.problems[0])
    eq(wrongType.entries['video.pro'].low, 18, 'built-in must survive')
    const negative = loadRates({ env: { SSH_RATES: '{"video":{"pro":-3}}' }, cwd: NOWHERE, quiet: true })
    eq(negative.entries['video.pro'].low, 18, 'a negative rate is not a rate')
  })

  t('override: the two unit confusions are refused, not obeyed', () => {
    /* Dollars where credits belong would price a run at 1/200th of the truth. */
    const dollars = loadRates({ env: { SSH_RATES: '{"video":{"pro":{"usd":0.09}}}' }, cwd: NOWHERE, quiet: true })
    eq(dollars.entries['video.pro'].low, 18, 'built-in must survive')
    ok(/denominated in CREDITS, not dollars/.test(dollars.problems[0]), dollars.problems[0])
    /* creditUsd inverted would multiply every dollar figure by 40,000. */
    const inverted = loadRates({ env: { SSH_RATES: '{"creditUsd":200}' }, cwd: NOWHERE, quiet: true })
    eq(inverted.entries.creditUsd.low, 0.005, 'built-in must survive')
    ok(/DOLLARS PER CREDIT/.test(inverted.problems[0]), inverted.problems[0])
    /* ...and the legitimate discounted-tier value still goes through. */
    const good = loadRates({ env: { SSH_RATES: '{"creditUsd":0.0045}' }, cwd: NOWHERE, quiet: true })
    eq(good.problems.length, 0)
    eq(good.entries.creditUsd.low, 0.0045)
  })

  t('override: a rates file is read, and SSH_RATES outranks it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-rates-'))
    try {
      fs.writeFileSync(path.join(dir, 'ssh-rates.json'), '{"video":{"pro":9},"image":{"2K":3}}')
      const fileOnly = loadRates({ env: {}, cwd: dir, quiet: true })
      eq(fileOnly.entries['video.pro'].low, 9)
      const both = loadRates({ env: { SSH_RATES: '{"video":{"pro":7}}' }, cwd: dir, quiet: true })
      eq(both.entries['video.pro'].low, 7, 'SSH_RATES must win')
      eq(both.entries['image.2K'].low, 3, 'the file still fills the gaps')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  t('calibrate: a small divergence is reported as the table holding', () => {
    const est = estimateTween({ segments: 5, seconds: 5, mode: 'std', rates: R() })  /* 350 */
    const cal = calibrate(est, { credits: 350, units: 25 }, { rates: R() })
    eq(cal.within, true)
    eq(cal.delta.credits, 0)
    eq(cal.suggestion, null)
    ok(/rate table held/.test(formatCalibration(cal)[0]), formatCalibration(cal)[0])
  })

  t('calibrate: a big divergence names the measured rate and how to pin it', () => {
    const est = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: R() })  /* 450 */
    const cal = calibrate(est, { credits: 150, units: 25 }, { rates: R() })
    eq(cal.within, false)
    eq(cal.observed.perUnit, 6)
    eq(cal.suggestion.key, 'video.pro')
    eq(cal.suggestion.creditsPerUnit, 6)
    eq(cal.suggestion.json, '{"video.pro":6}')
    const lines = formatCalibration(cal)
    ok(/67% HIGH/.test(lines[0]), lines[0])
    ok(/SSH_RATES=\{"video\.pro":6\}/.test(lines[2]), lines[2])
  })

  t('calibrate: the suggested rate is quoted in the run\'s own conversion', () => {
    const r = loadRates({ env: { SSH_RATES: '{"creditUsd":0.004}' }, cwd: NOWHERE, quiet: true })
    const est = estimateTween({ segments: 5, seconds: 5, mode: 'pro', rates: r })
    const cal = calibrate(est, { credits: 150, units: 25 }, { rates: r })
    eq(cal.suggestion.creditsPerUnit, 6)
    near(cal.suggestion.usdPerUnit, 0.024, 'usd per second at the pinned conversion')
  })

  t('calibrate: tolerance is measured from the nearest edge of a range', () => {
    /* Pinned to a range on purpose - every built-in rate is now a point value, and the edge
       arithmetic is exactly what would rot unnoticed if nothing exercised it. */
    const r = loadRates({ env: { SSH_RATES: '{"video.std":[14,15]}' }, cwd: NOWHERE, quiet: true })
    const est = estimateTween({ segments: 1, seconds: 10, mode: 'std', rates: r })  /* 140-150 */
    eq(calibrate(est, { credits: 145, units: 10 }, { rates: r }).within, true, 'inside the range')
    eq(calibrate(est, { credits: 160, units: 10 }, { rates: r }).within, true, '6.7% over the top edge')
    eq(calibrate(est, { credits: 180, units: 10 }, { rates: r }).within, false, '20% over the top edge')
    eq(calibrate(est, { credits: 130, units: 10 }, { rates: r }).within, true, '7% under the bottom edge')
    eq(calibrate(est, { credits: 100, units: 10 }, { rates: r }).within, false, '29% under the bottom edge')
  })

  t('calibrate: an array of per-segment figures is accepted', () => {
    const est = estimateTween({ segments: 3, seconds: 5, mode: 'pro', rates: R() })   /* 270 */
    const cal = calibrate(est, [90, 90, 90])
    eq(cal.observed.credits, 270)
    eq(cal.within, true)
  })

  t('calibrate: no observations means no verdict, not a false one', () => {
    const est = estimateTween({ segments: 3, seconds: 5, mode: 'pro', rates: R() })
    const cal = calibrate(est, [])
    eq(cal.ok, false)
    eq(formatCalibration(cal).length, 0)
  })

  t('observedFromSegments: sums credits and SECONDS, skips unbilled segments', () => {
    const segs = {
      3: { creditsConsumed: 90, duration: 5, mode: 'pro' },
      4: { creditsConsumed: 90, duration: 5, mode: 'pro' },
      5: { taskId: 'x', duration: 5, mode: 'pro' },
    }
    const o = observedFromSegments(segs)
    eq(o.credits, 180); eq(o.units, 10); eq(o.segments, 2)
    eq(observedFromSegments(segs, { only: [3] }).credits, 90)
    eq(observedFromSegments({}).credits, null)
  })

  t('balance: a good answer, in either body shape', () => {
    const r = R()
    const mk = (payload) => async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(payload),
    })
    return Promise.all([
      fetchBalance({ apiKey: 'k', fetchImpl: mk({ code: 200, data: 4182 }), rates: r }),
      fetchBalance({ apiKey: 'k', fetchImpl: mk({ code: 200, data: { credits: 4182 } }), rates: r }),
      fetchBalance({ apiKey: 'k', fetchImpl: mk({ code: 200, data: { remainingCredits: '4182' } }), rates: r }),
    ]).then(([a, b, c]) => {
      for (const bal of [a, b, c]) { eq(bal.known, true, JSON.stringify(bal)); eq(bal.credits, 4182) }
      near(a.usd, 20.91, 'usd')
      eq(formatBalance(a), 'balance 4,182 credits (~$20.91)')
    })
  })

  t('balance: every failure degrades, none throws', () => {
    const cases = [
      ['no key', { apiKey: '', fetchImpl: async () => { throw new Error('should not be called') } }],
      ['network down', { apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNREFUSED') } }],
      ['html interstitial', { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>' }) }],
      ['code 401 inside a 200', { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"code":401,"msg":"unauthorised"}' }) }],
      ['http 500', { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, text: async () => '{}' }) }],
      ['unrecognised shape', { apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"code":200,"data":{"wallet":{"x":1}}}' }) }],
      ['no fetch at all', { apiKey: 'k', fetchImpl: 'not a function' }],
    ]
    return Promise.all(cases.map(([, opts]) => fetchBalance(opts))).then((results) => {
      results.forEach((bal, i) => {
        eq(bal.known, false, cases[i][0])
        eq(bal.credits, null, cases[i][0])
        ok(bal.reason && bal.reason.length > 3, `${cases[i][0]} gave no reason`)
        ok(!/Bearer|\bk\b/.test(bal.reason), `${cases[i][0]} leaked something key-shaped: ${bal.reason}`)
        ok(/^balance unknown \(/.test(formatBalance(bal)), formatBalance(bal))
      })
    })
  })

  t('balance: a shortfall is called out against the high end of the estimate', () => {
    const r = R()
    const est = estimateRun({ steps: 6, rates: r })            /* up to 512 credits */
    eq(formatBalance({ known: true, credits: 4182, usd: 20.91 }, est), 'balance 4,182 credits (~$20.91)')
    ok(/NOT enough/.test(formatBalance({ known: true, credits: 100, usd: 0.5 }, est)))
  })

  console.log('\npricing.mjs self-test - offline, no key, no network\n')
  let pass = 0
  let fail = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      pass++
      console.log(`  ok    ${name}`)
    } catch (e) {
      fail++
      console.log(`  FAIL  ${name}\n        ${(e && e.message) || e}`)
    }
  }
  try { fs.rmSync(NOWHERE, { recursive: true, force: true, maxRetries: 5 }) } catch (_) {}
  console.log(`\n${pass} passed, ${fail} failed\n`)
  /* exitCode rather than exit(), matching doctor.mjs - and here it also lets the loop drain. */
  process.exitCode = fail ? 1 : 0
}
