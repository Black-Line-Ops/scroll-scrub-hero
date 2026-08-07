/* sniffMime, reached the only way it can be: through uploadFile, its single caller.

   sniffMime is not exported, and the audit's rule is not to duplicate a function in order to test
   it - a copy can agree with itself while both are wrong. So this replaces globalThis.fetch with
   a recorder and drives the real uploadFile. Nothing leaves the machine: the recorder answers
   every request itself, and it FAILS the test if a request goes anywhere other than the upload
   host, so a stray call cannot be mistaken for a pass.

   What is being locked down:
     - the mime and the extension always come from the same sniff and therefore always agree. The
       old fallback declared an unknown file image/png while still naming it .heic, so an iPhone
       photo went up advertising two different types at once and came back as a model-shaped error
       for a file-format problem.
     - the extension on disk is not evidence. A JPEG copied to a .png name uploads as a JPEG.
     - a file we cannot recognise is REFUSED before any request, not guessed at.
     - the upload host. CRITICAL-3: this route does not exist on api.kie.ai, and pointing it back
       there kills every cold start at its first network call with `HTTP 404 - No message
       available`, which never prints the URL it called. It looks exactly like a typo, so it needs
       a test standing on it. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { uploadFile } from '../scripts/kie.mjs'
import { tmpDir } from './helpers/harness.mjs'

const UPLOAD_URL = 'https://kieai.redpandaai.co/api/file-base64-upload'

const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 0x11)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 0x22)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(64, 0x33)])
/* `ftypheic` at offset 4 - what actually comes off an iPhone, and the case the old fallback
   mislabelled instead of rejecting. */
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(64, 0x44)])

const dir = tmpDir('ssh-upload-')
const put = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); return p }

const OK = () => new Response(JSON.stringify({ code: 200, data: { fileUrl: 'https://files.invalid/x.bin' } }),
  { status: 200, headers: { 'content-type': 'application/json' } })

/* Stand in for the network for the duration of one call, and hand back what was "sent".
   requireKey() reads the environment, so a key has to exist for the call to get as far as the
   recorder - it is a literal, it is restored afterwards, and it never leaves this process. */
async function capture (fn, responder = OK) {
  const realFetch = globalThis.fetch
  const realKey = process.env.KIE_API_KEY
  process.env.KIE_API_KEY = 'test-key-that-is-never-sent-anywhere'
  const calls = []
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null })
    return responder(String(url), opts)
  }
  try {
    const value = await fn().then(v => ({ ok: true, v }), e => ({ ok: false, e }))
    return { ...value, calls }
  } finally {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.KIE_API_KEY
    else process.env.KIE_API_KEY = realKey
  }
}

test('the sniffed type and the sniffed extension always agree', async (t) => {
  const cases = [
    ['photo.jpg', JPEG, 'image/jpeg', 'photo.jpg'],
    ['photo.png', PNG, 'image/png', 'photo.png'],
    ['photo.webp', WEBP, 'image/webp', 'photo.webp'],
    /* The extension is not evidence. A JPEG copied to a .png name is still a JPEG, and the name
       that goes up has to follow the bytes, not the other way round. */
    ['mislabelled.png', JPEG, 'image/jpeg', 'mislabelled.jpg'],
    ['NO-EXTENSION', PNG, 'image/png', 'NO-EXTENSION.png'],
    ['dotted.name.here.jpeg', WEBP, 'image/webp', 'dotted.name.here.webp'],
  ]

  for (const [name, bytes, mime, fileName] of cases) {
    await t.test(`${name} (${bytes.subarray(0, 4).toString('hex')}) uploads as ${mime}`, async () => {
      const r = await capture(() => uploadFile(put(name, bytes)))
      assert.ok(r.ok, `upload threw: ${r.e && r.e.message}`)
      assert.equal(r.calls.length, 1)
      assert.equal(r.calls[0].url, UPLOAD_URL,
        'the base64 upload route does not exist on api.kie.ai - see UPLOAD_BASE in kie.mjs')
      assert.equal(r.calls[0].body.fileName, fileName)
      assert.ok(r.calls[0].body.base64Data.startsWith(`data:${mime};base64,`),
        `declared ${r.calls[0].body.base64Data.slice(0, 40)}, expected data:${mime}`)
      /* The declared type and the declared name must not be able to disagree. */
      const declared = r.calls[0].body.base64Data.slice(5, r.calls[0].body.base64Data.indexOf(';'))
      assert.equal(declared.split('/')[1].replace('jpeg', 'jpg'), path.extname(fileName).slice(1))
      assert.equal(r.v.url, 'https://files.invalid/x.bin')
      assert.equal(typeof r.v.uploadedAt, 'number', 'the RECORD shape is what freshUrl needs')
    })
  }
})

test('the bytes are what is uploaded, not a re-encoding', async () => {
  const r = await capture(() => uploadFile(put('roundtrip.jpg', JPEG)))
  const b64 = r.calls[0].body.base64Data.split(',')[1]
  assert.ok(Buffer.from(b64, 'base64').equals(JPEG))
  assert.equal(r.calls[0].body.uploadPath, 'images')
})

test('an unrecognised file is refused before anything is sent', async (t) => {
  for (const [name, bytes] of [['iphone.heic', HEIC], ['empty.jpg', Buffer.alloc(0)],
    ['truncated.png', Buffer.from([0x89, 0x50])], ['notes.txt', Buffer.from('hello there')]]) {
    await t.test(`${name} is rejected`, async () => {
      const r = await capture(() => uploadFile(put(name, bytes)))
      assert.equal(r.ok, false, `${name} should not have been accepted`)
      assert.equal(r.calls.length, 0, 'a rejected file must not reach the network')
      assert.match(r.e.message, /is not a JPEG, PNG or WebP/)
      assert.ok(r.e.message.includes(name), 'the message has to name the file')
      /* Windows is a first-class target, so the remedy has to be a command, not a package
         manager the reader may not have. ffmpeg is already a hard requirement of this skill. */
      assert.match(r.e.message, /ffmpeg -i /)
      assert.doesNotMatch(r.e.message, /brew |apt-get |sudo /)
    })
  }
})

test('an oversized file is refused before it is base64-encoded', async () => {
  /* base64 inflates the read by a third, JSON.stringify holds a second copy and the wire encoding
     a third, so a 10 MB file is already ~40 MB of live memory in one request. */
  const big = put('huge.jpg', Buffer.concat([JPEG, Buffer.alloc(11 * 1024 * 1024, 0x55)]))
  const r = await capture(() => uploadFile(big))
  assert.equal(r.ok, false)
  assert.equal(r.calls.length, 0)
  assert.match(r.e.message, /over the 10 MB upload limit/)
  assert.match(r.e.message, /ffmpeg -i /, 'and it should say how to downscale')
})

test('the key is sent as a bearer token and nothing else is', async () => {
  const r = await capture(() => uploadFile(put('auth.jpg', JPEG)))
  const h = r.calls[0].opts.headers
  assert.equal(h.Authorization, 'Bearer test-key-that-is-never-sent-anywhere')
  /* Accept is not decoration: without it the server's default decides whether we get JSON or an
     event stream, and kie.ai's own docs contradict themselves about what that default is. */
  assert.equal(h.Accept, 'application/json')
  assert.equal(h['Content-Type'], 'application/json')
})

test('a non-JSON response names the content-type instead of becoming an empty object', async () => {
  /* CRITICAL-4. `try { body = await res.json() } catch { body = {} }` swallowed an event stream,
     an HTML error page or a proxy interstitial whole: res.ok stayed true, no error code fired,
     and the failure surfaced as `sol returned no text: {}` - blaming the model for a transport
     problem. */
  const html = () => new Response('<html><body>Proxy authentication required</body></html>',
    { status: 200, headers: { 'content-type': 'text/html' } })
  const r = await capture(() => uploadFile(put('proxied.jpg', JPEG)), html)
  assert.equal(r.ok, false)
  assert.match(r.e.message, /expected a JSON response, got text\/html/)
  assert.match(r.e.message, /Proxy authentication required/, 'and it should quote what came back')
})

test('a 200 carrying an error code in the body is not success', async () => {
  /* kie.ai signals auth and quota failures INSIDE a 200. Checking res.ok is not enough - a bad
     key looks like success until you read the body. */
  const broke = () => new Response(JSON.stringify({ code: 402, msg: 'no credits' }),
    { status: 200, headers: { 'content-type': 'application/json' } })
  const r = await capture(() => uploadFile(put('broke.jpg', JPEG)), broke)
  assert.equal(r.ok, false)
  assert.match(r.e.message, /kie\.ai code 402/)
  assert.match(r.e.message, /INSUFFICIENT CREDITS/, 'the two codes that happen mid-run need naming, not echoing')
})

test('a 4xx never retries a billable-adjacent call into a second request', async () => {
  /* uploadFile is capped at two attempts because `opts` is built once and reused, so every retry
     re-sends the whole multi-megabyte body. A 4xx is not retryable at all.
     The rest of the retry policy - the create that must never be replayed, and the poll and the
     upload 5xx that must keep being replayed - is in retry-policy.test.mjs. Keep the two in step:
     this case is about the STATUS class, that file is about the CALL being billable. */
  const gone = () => new Response(JSON.stringify({ msg: 'No message available' }),
    { status: 404, headers: { 'content-type': 'application/json' } })
  const r = await capture(() => uploadFile(put('missing.jpg', JPEG)), gone)
  assert.equal(r.ok, false)
  assert.equal(r.calls.length, 1, 'a 404 is a wrong URL, not a hiccup - re-sending the body twice helps nobody')
  assert.match(r.e.message, /HTTP 404/)
})
