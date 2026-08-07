/* CRITICAL-5, and the reason it needs a file of its own.

   uploadFile() resolves to a RECORD - {url, uploadedAt} - and every consumer has to reach through
   to .url before putting it on the wire. storyboard.mjs was the one caller that forgot, so the
   payload carried

     "image_url": {"url": "https://...", "uploadedAt": 1786089554909}

   where kie.ai wants a bare string. The server answered HTTP 500, which the client treated as
   retryable, so a deterministic client-side type error was replayed five times over 22.5 seconds
   while printing "500 from kie.ai, retrying in Ns" - the client blaming the server for its own
   malformed request.

   A mutation run found this fix caught only as collateral: reverting the unwrap reddened all
   fifteen storyboard-schema tests at once, and every one of them failed on a bare `1 !== 0`
   exit-code assertion that named neither image_url nor the unwrap. That is a fix with no
   diagnostic - the next person to hit it learns only that "storyboard is broken".

   The defect is invisible in the OUTPUT, because the staged client answers correctly whether it
   was handed a string or a record. It is only visible in the ARGUMENTS the caller built, so the
   harness stub records them and these tests read them back. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard } from './helpers/harness.mjs'

/* Run the real storyboard.mjs against a canned Sol response and hand back what sol() was called
   with. Nothing is uploaded, nothing is generated, and any paid call throws.

   `sbPath`, not `out`: runScript already returns `out` as stdout+stderr, and shadowing it makes
   every failure here report a file path where the script's own error belongs. */
function askAndCapture (extra = []) {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder - the staged client never reads it')
  const sbPath = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare yard to finished pool', '--steps', '4', '--out', sbPath, ...extra])

  const callFile = path.join(dir, 'sol-call.json')
  return {
    ...r,
    sbPath,
    called: fs.existsSync(callFile) ? JSON.parse(fs.readFileSync(callFile, 'utf8')) : null,
  }
}

/* storyboard.mjs has a client-side guard that rejects a non-string image_url before it reaches the
   wire. If only the unwrap is reverted, that guard fires and the run exits 1 - which is correct
   behaviour, but a bare "1 !== 0" names neither the cause nor the guard. Say which one it was. */
function assertRan (r) {
  if (r.status === 0) return
  const guarded = /image_url must be a URL string/.test(r.stderr)
  assert.fail(guarded
    ? 'the image_url guard fired, so the unwrap at storyboard.mjs:74-75 is reverted or broken:\n' + r.stderr.trim()
    : `storyboard.mjs exited ${r.status}:\n${r.out.trim()}`)
}

/* Pull every image the call put on the wire, wherever in the argument list the messages ended up.
   Deliberately shape-agnostic: this test is about the VALUE at image_url, and it should keep
   working if the call signature is refactored around it. */
function imagesOf (called) {
  const found = []
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      if ('image_url' in v) found.push(v.image_url)
      Object.values(v).forEach(walk)
    }
  }
  walk(called)
  return found
}

test('the reference photo reaches Sol as a URL string, not as the upload record', () => {
  const r = askAndCapture()

  assertRan(r)
  assert.notEqual(r.called, null, 'sol() was never called - the test cannot see the payload')

  const images = imagesOf(r.called)
  assert.equal(images.length, 1, `expected exactly one image on the wire, got ${images.length}`)

  assert.equal(typeof images[0], 'string',
    'image_url carried ' + JSON.stringify(images[0]) + ' - that is uploadFile\'s {url, uploadedAt} ' +
    'record, not a URL. kie.ai answers 500 and the client retries it five times.')
  assert.match(images[0], /^https?:\/\//)
})

test('a --ref2 "after" photo is unwrapped too, not just the first one', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const ref2 = write(path.join(dir, 'finished.jpg'), 'placeholder')
  const sbPath = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--ref2', ref2, '--idea', 'bare yard to finished pool', '--steps', '4', '--out', sbPath])

  assertRan(r)
  const called = JSON.parse(fs.readFileSync(path.join(dir, 'sol-call.json'), 'utf8'))
  const images = imagesOf(called)

  /* The second slot is the one that was fixed in the same edit and is easy to leave behind: the
     original bug was two lines, and a fix applied to only the first would pass the test above. */
  assert.equal(images.length, 2, `--ref2 should put a second image on the wire, got ${images.length}`)
  for (const [i, img] of images.entries()) {
    assert.equal(typeof img, 'string', `image ${i + 1} of 2 is ${JSON.stringify(img)}, not a URL string`)
    assert.match(img, /^https?:\/\//)
  }
})

test('no upload record leaks anywhere else into the payload', () => {
  const r = askAndCapture()
  assertRan(r)

  /* uploadedAt is the tell. It exists only on the record uploadFile returns, so if that token
     appears anywhere in the serialised call, a record reached the wire by some other route -
     nested in _meta, spread into a message, or a second call site added later. */
  const wire = JSON.stringify(r.called)
  assert.equal(/uploadedAt/.test(wire), false,
    'an upload record reached the Sol payload:\n' + wire.slice(0, 400))
})
