/* The key-setup helper, and specifically the part that guesses what a stranger pasted.

   This is the first thing anyone does with this skill and the only step that has nothing to do
   with what they came here to build, so it is where people are lost. Every case below is a real
   way a key arrives wrong, and every one of them produces a string that LOOKS correct in a
   terminal and is rejected by kie.ai as an HTTP 200 containing {"code":401} — which reads like a
   server fault rather than a paste fault. Cleaning them here is the difference between "it works"
   and "it says my key is invalid and I do not know why".

   The refusal cases matter as much as the fixes: a key with a space in the middle is not a key
   with a stray space, it is two things, and silently keeping the first half would produce a
   confident failure later. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { clean, check } from '../scripts/connect-key.mjs'

const KEY = '6d2a4f1c8b3e9074a5d1e2f3c4b5a697'          /* shape of a real kie.ai key: 32 chars, no prefix */

test('a clean key passes through untouched', () => {
  assert.equal(clean(KEY), KEY)
})

for (const [label, pasted] of [
  ['a trailing newline', `${KEY}\n`],
  ['leading and trailing whitespace', `   ${KEY}  `],
  ['a non-breaking space from a web page', ` ${KEY} `],
  ['double quotes from a code block', `"${KEY}"`],
  ['single quotes', `'${KEY}'`],
  ['the whole assignment', `KIE_API_KEY=${KEY}`],
  ['the assignment with spaces', `KIE_API_KEY = ${KEY}`],
  ['the assignment, quoted', `KIE_API_KEY="${KEY}"`],
  ['a copied export line', `export KIE_API_KEY="${KEY}"`],
  ['a copied Windows set line', `set KIE_API_KEY=${KEY}`],
  ['a copied setx line', `setx KIE_API_KEY "${KEY}"`],
  ['a copied PowerShell line', `$env:KIE_API_KEY = "${KEY}"`],
  ['lowercase variable name', `kie_api_key=${KEY}`],
]) {
  test(`recovers the key from ${label}`, () => {
    assert.equal(clean(pasted), KEY, `this is a real way people paste it and it must not reach the API as-is`)
  })
}

test('an empty paste stays empty rather than becoming something', () => {
  /* The caller treats empty as "keep what you had" / "nothing entered", so clean() inventing a
     value here would turn a no-op into a wrong key. */
  assert.equal(clean(''), '')
  assert.equal(clean('   \n  '), '')
})

test('a key with a space in the MIDDLE is left alone for the caller to refuse', () => {
  /* Not a stray space - two things. Trimming it to the first half would hand kie.ai a truncated
     key and turn a clear "that has a space in it" into an opaque rejection. */
  const twoThings = '6d2a4f1c8b3e9074 a5d1e2f3c4b5a697'
  assert.match(clean(twoThings), /\s/, 'the space must survive so the caller can reject it')
})

test('it does not eat a key that legitimately starts with a stripped word', () => {
  /* "set" and "export" are stripped only as a whole leading WORD followed by whitespace. A key
     beginning with those letters is not an assignment and must survive intact. */
  assert.equal(clean('setxabc123def456'), 'setxabc123def456')
  assert.equal(clean('exportedkey123'), 'exportedkey123')
})

test('check() reports a rejection carried inside an HTTP 200', async () => {
  /* kie.ai's defining quirk. A checker that trusts res.status would call a dead key good and the
     helper would happily save it - which is the exact failure this whole script exists to stop. */
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ code: 401, msg: 'Unauthorized' }) })
  try {
    const v = await check('whatever')
    assert.equal(v.ok, false, 'a 200 carrying code 401 is a rejection')
    assert.match(v.why, /rejected/)
  } finally { globalThis.fetch = realFetch }
})

test('check() accepts the 404 the probe is expected to produce', async () => {
  /* The probe asks for a task id that does not exist on purpose, so "not found" is the SUCCESS
     signal: the request was authenticated well enough to be told the task is missing. */
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ code: 404, msg: 'not found' }) })
  try {
    assert.equal((await check('whatever')).ok, true)
  } finally { globalThis.fetch = realFetch }
})

test('check() treats an unreachable network as offline, not as a bad key', async () => {
  /* Different advice for the user, and the wrong one sends them hunting for a new key on a train. */
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND api.kie.ai') }
  try {
    const v = await check('whatever')
    assert.equal(v.ok, false)
    assert.equal(v.offline, true)
  } finally { globalThis.fetch = realFetch }
})

test('importing the module does not run the interactive prompt', () => {
  /* The whole file is a top-level program; the main() guard is what lets this test file exist at
     all. If that guard regresses, this suite hangs on a hidden prompt rather than failing. */
  assert.equal(typeof clean, 'function')
  assert.equal(typeof check, 'function')
})
