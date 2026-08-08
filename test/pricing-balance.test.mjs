/* The credit-balance lookup, and the one property it exists to have: it FAILS SOFT.

   fetchBalance is the only thing in scripts/pricing.mjs that touches a network. It is called from
   both spend gates and from doctor.mjs, and in every case it is called for a nice-to-have: the
   gate is allowed to proceed without knowing the balance. So the day it starts throwing - because
   a proxy answered HTML, or the DNS went, or kie.ai renamed the field - it stops being a feature
   and becomes the reason nobody can generate anything. Worse, a lookup that HANGS blocks the y/n
   prompt behind it with no explanation at all.

   Every test below therefore checks two things at once: the right answer, and that getting it
   wrong is survivable. `known:false` plus a reason is a pass. A throw is a failure. So is a wait.

   Nothing here reaches the network. fetchBalance takes a `fetchImpl` seam for exactly this, and
   the two cases that do NOT pass one replace globalThis.fetch with a recorder that answers
   locally and fails the test if a request goes anywhere other than kie.ai's credit route. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fetchBalance, formatBalance, estimateRun, loadRates } from '../scripts/pricing.mjs'
import { tmpDir } from './helpers/harness.mjs'

const NOWHERE = tmpDir('ssh-bal-rates-')
const R = () => loadRates({ env: {}, cwd: NOWHERE, quiet: true })

const BALANCE_URL = 'https://api.kie.ai/api/v1/chat/credit'
/* Deliberately key-shaped. Every assertion about leakage below greps for this exact string, so a
   reason line that ever quotes the credential fails loudly instead of being read past. */
const KEY = 'sk-live-DO-NOT-PRINT-ME-0123456789'

const answer = (payload, { status = 200, ok = true } = {}) => async () => ({
  ok, status, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
})

test('a good answer is read, whatever shape kie.ai puts the number in', async () => {
  /* The success body was never verified against a live account - the route was probed
     unauthenticated and answered "route exists, credentials do not". So the parser accepts a bare
     number at `data` or any of several field names, and all of them have to keep working: the
     first authenticated run is what settles which one is real, and until then guessing wrong in
     either direction is worse than the alternatives. */
  const rates = R()
  for (const payload of [
    { code: 200, data: 4182 },
    { code: 200, data: { credits: 4182 } },
    { code: 200, data: { remainingCredits: 4182 } },
    { code: 200, data: { balance: 4182 } },
    /* kie.ai returns some numeric fields as strings elsewhere in this API. */
    { code: 200, data: { remainingCredits: '4182' } },
  ]) {
    const bal = await fetchBalance({ apiKey: KEY, fetchImpl: answer(payload), rates })
    assert.equal(bal.known, true, JSON.stringify(payload))
    assert.equal(bal.credits, 4182, JSON.stringify(payload))
    assert.ok(Math.abs(bal.usd - 20.91) < 1e-9, `usd was ${bal.usd}`)
    assert.equal(formatBalance(bal), 'balance 4,182 credits (~$20.91)')
  }

  /* And the anchor again, from the other end: a thousand credits is five dollars on the balance
     line as well as on the cost line, or the two halves of the gate disagree about the currency. */
  const anchor = await fetchBalance({ apiKey: KEY, fetchImpl: answer({ code: 200, data: 1000 }), rates })
  assert.equal(formatBalance(anchor), 'balance 1,000 credits (~$5.00)')
})

test('every failure degrades to "unknown" - none throws, none blocks, none guesses', async () => {
  const cases = [
    ['no key at all', { apiKey: '', fetchImpl: async () => { assert.fail('no key must mean no request') } }],
    ['the network is down', { apiKey: KEY, fetchImpl: async () => { throw new Error('ECONNREFUSED 1.2.3.4:443') } }],
    ['DNS failure', { apiKey: KEY, fetchImpl: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND api.kie.ai'), { code: 'ENOTFOUND' }) } }],
    ['a real HTTP 401', { apiKey: KEY, fetchImpl: answer('{"code":401,"msg":"unauthorised"}', { status: 401, ok: false }) }],
    ['code 401 inside an HTTP 200', { apiKey: KEY, fetchImpl: answer({ code: 401, msg: 'unauthorised' }) }],
    ['HTTP 500', { apiKey: KEY, fetchImpl: answer('{}', { status: 500, ok: false }) }],
    ['an HTML proxy interstitial', { apiKey: KEY, fetchImpl: answer('<html>Proxy authentication required</html>') }],
    ['an empty body', { apiKey: KEY, fetchImpl: answer('') }],
    ['JSON that is not an object', { apiKey: KEY, fetchImpl: answer('"hello"') }],
    ['a recognised-looking body with no number in it', { apiKey: KEY, fetchImpl: answer({ code: 200, data: { wallet: { x: 1 } } }) }],
    ['a credits field that is not a number', { apiKey: KEY, fetchImpl: answer({ code: 200, data: { credits: 'lots' } }) }],
    ['text() itself throwing', { apiKey: KEY, fetchImpl: async () => ({ ok: true, status: 200, text: async () => { throw new Error('socket hang up') } }) }],
    ['fetchImpl is not callable', { apiKey: KEY, fetchImpl: 'not a function' }],
  ]

  for (const [label, opts] of cases) {
    /* No try/catch. If fetchBalance throws, this test fails with the throw, which is the point:
       a rejected promise here is a spend gate that cannot open. */
    const bal = await fetchBalance({ ...opts, rates: R() })

    assert.equal(bal.known, false, label)
    assert.equal(bal.credits, null, `${label}: an unknown balance must not become a number`)
    assert.equal(bal.usd, null, label)
    assert.ok(bal.reason && bal.reason.length > 3, `${label} degraded with no reason attached`)
    /* The reason is printed inside a spend gate, so the credential must not be in it. */
    assert.ok(!bal.reason.includes(KEY), `${label} leaked the key: ${bal.reason}`)
    assert.doesNotMatch(bal.reason, /Bearer/, label)
    assert.match(formatBalance(bal), /^balance unknown \(/, label)
    /* Not zero. "balance 0 credits" reads as an empty account and would send somebody off to top
       up a wallet that is fine, or - worse in the other direction - satisfy a shortfall check. */
    assert.doesNotMatch(formatBalance(bal), /\b0 credits\b/, label)
  }
})

test('a lookup that never answers gives up on its own deadline', async () => {
  /* The failure mode with no error message: the gate prints nothing and waits. AbortSignal.timeout
     is passed to the fetch, so a well-behaved client rejects on it - and fetchBalance has to turn
     that rejection into an unknown rather than propagate it. 120ms rather than the real 8s only
     because the test should not take eight seconds; the mechanism is identical. */
  const hangs = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason || new Error('aborted')))
  })
  const started = Date.now()
  const bal = await fetchBalance({ apiKey: KEY, fetchImpl: hangs, timeoutMs: 120, rates: R() })
  const waited = Date.now() - started

  assert.equal(bal.known, false)
  assert.ok(bal.reason.length > 3, 'a timeout still owes the reader an explanation')
  assert.ok(!bal.reason.includes(KEY))
  assert.ok(waited < 4000, `waited ${waited}ms - the deadline is not being honoured`)
})

test('one attempt, one URL, one bearer header - and no retry', async () => {
  /* Retry is deliberately absent. Everything a create is right to replay would, here, make a gate
     wait through several backoffs for a number it is allowed not to have. This is also the only
     test that exercises the DEFAULT transport, so it is the one that would notice the request
     going somewhere other than the credit route. */
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    assert.equal(String(url), BALANCE_URL, 'the balance lookup must not call anything else')
    throw new Error('ECONNRESET')
  }
  try {
    const bal = await fetchBalance({ apiKey: KEY, rates: R() })
    assert.equal(bal.known, false)
    assert.equal(calls.length, 1, 'a balance lookup that retries makes a gate wait for a nice-to-have')
    assert.equal(calls[0].opts.headers.Authorization, `Bearer ${KEY}`)
    assert.equal(calls[0].opts.headers.Accept, 'application/json')
    /* The key goes in the header and nowhere else - not the URL, not a query string. */
    assert.ok(!calls[0].url.includes(KEY), 'the key must never reach a URL')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a shortfall is measured against the HIGH end of the estimate', async () => {
  /* Running out halfway leaves paid-for fragments and no hero, so the high end is the only end
     worth checking. A six-step pro run tops out at 516.72 credits, which the line rounds to 517. */
  const rates = R()
  const est = estimateRun({ steps: 6, seconds: 5, mode: 'pro', resolution: '2K', rates })
  assert.ok(Math.abs(est.credits.high - 516.72) < 1e-9, `the boundary moved: ${est.credits.high}`)

  const at = (credits) => formatBalance({ known: true, credits, usd: credits * 0.005 }, est)
  assert.match(at(516), /NOT enough for this run, which needs up to ~517/, 'one credit short is short')
  assert.doesNotMatch(at(517), /NOT enough/, 'and enough is enough - a gate that always warns is ignored')
  assert.equal(at(4182), 'balance 4,182 credits (~$20.91)')

  /* An unknown balance must never be read as a shortfall. Not knowing is not the same as empty,
     and printing "NOT ENOUGH CREDIT" at somebody whose account is full is how a real warning
     stops being read. */
  const unknown = await fetchBalance({ apiKey: '', rates })
  assert.equal(formatBalance(unknown, est), 'balance unknown (KIE_API_KEY is not set)')
  assert.doesNotMatch(formatBalance(unknown, est), /NOT enough/)

  /* A FLOOR is a lower bound, and formatBalance compares against whatever high end it is given -
     so on a partial estimate it can say "not enough" (which is sound: under the floor is under the
     total) but it can never say "enough". Pinned here because it is the reason both spend gates
     add `&& !est.partial` before raising their own NOT ENOUGH CREDIT banner: silence from this
     line on a partial estimate means unknown, not covered. */
  const partial = estimateRun({ steps: 6, resolution: '8K', rates })
  assert.equal(partial.partial, true)
  assert.ok(Math.abs(partial.credits.high - 456.72) < 1e-9, `the floor moved: ${partial.credits.high}`)
  assert.match(formatBalance({ known: true, credits: 100, usd: 0.5 }, partial), /NOT enough/,
    'below the floor is below the total, whatever the missing stage costs')
  assert.doesNotMatch(formatBalance({ known: true, credits: 500, usd: 2.5 }, partial), /NOT enough/,
    'above the floor is not the same as covered - the scripts gate on est.partial for this')
})
