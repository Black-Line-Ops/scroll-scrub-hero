/* The retry policy, which is the only thing standing between a hiccup and a DOUBLE BILL.

   `req()` in scripts/kie.mjs takes an `idempotent` flag, and `createTask` is the one caller that
   passes `false`. That single argument is the whole fix for HIGH-4: kie.ai accepts no idempotency
   key, so a create that the server had already accepted, replayed, becomes a second billed render
   whose taskId we never learn - an orphan nobody collects and nobody sees. Everything else in the
   client is a GET or an upload and is free to replay.

   Until this file existed the fix had ZERO regression coverage: grepping the suite for
   createTask/idempotent/pollTask returned only the harness's BILLABLE stubs. It worked, but the
   next refactor could have undone it silently, on the one code path whose entire safety story is
   about not spending twice.

   So this asserts the request COUNT, not merely that something threw:

     - HTTP 5xx on a create      -> exactly ONE POST
     - socket dropped on a create-> exactly ONE POST, counted at the SERVER, which is the case that
                                    matters: the request arrived, the task exists, and the client
                                    cannot tell that from a request that never left
     - the operator is TOLD      -> the recordInfo warning, because a create that silently declines
                                    to retry reads like any other blip and the next move is to
                                    re-run the step by hand, which is the bill we just avoided
     - HTTP 429 on a create      -> still retried; rate-limited means turned away before anything
                                    was created, and it is the one status safe to replay
     - a poll, and an upload     -> STILL RETRY. Over-correcting into no-retry-anywhere would be its
                                    own regression and nothing else in the suite would catch it.

   Nothing here leaves the machine. Most tests answer fetch themselves; the socket-drop tests run a
   throwaway http server on 127.0.0.1 and rewrite the request onto it, because a real dropped
   connection produces a real undici failure and lets the server keep the count that money depends
   on. The upload 404 case is not repeated here - it is covered in kie-client.test.mjs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createTask, pollTask, uploadFile } from '../scripts/kie.mjs'
import { tmpDir } from './helpers/harness.mjs'

/* The genuine fetch, grabbed at import time - which is before any test has run, so it is never a
   stub. The socket-drop tests need it to reach the local server while globalThis.fetch is swapped. */
const NET = globalThis.fetch

const json = (obj, status = 200) => new Response(JSON.stringify(obj),
  { status, headers: { 'content-type': 'application/json' } })

const CREATED = () => json({ code: 200, data: { taskId: 'task-under-test' } })
const DONE = () => json({
  code: 200,
  data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://files.invalid/clip.mp4'] }) },
})

/* Stand in for the network for one call and hand back what was attempted. console.error and
   console.warn are collected too, because "did the operator get told" is one of the assertions
   here and the client reports it by printing, not by throwing something different.
   requireKey() reads the environment, so a key has to exist for the call to get this far - it is a
   literal, it is restored afterwards, and it never leaves this process. */
async function capture (fn, responder) {
  const realFetch = globalThis.fetch
  const realKey = process.env.KIE_API_KEY
  const realError = console.error
  const realWarn = console.warn
  process.env.KIE_API_KEY = 'test-key-that-is-never-sent-anywhere'
  const calls = []
  const logged = []
  console.error = (...a) => logged.push(a.join(' '))
  console.warn = (...a) => logged.push(a.join(' '))
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: String(opts.method || 'GET').toUpperCase() })
    return responder(String(url), opts, calls.length)
  }
  try {
    const value = await fn().then(v => ({ ok: true, v }), e => ({ ok: false, e }))
    return { ...value, calls, log: logged.join('\n') }
  } finally {
    globalThis.fetch = realFetch
    console.error = realError
    console.warn = realWarn
    if (realKey === undefined) delete process.env.KIE_API_KEY
    else process.env.KIE_API_KEY = realKey
  }
}

/* A server that counts what it received and then kills the connection. Counting on the SERVER side
   is the point: it is the server that would have created - and billed for - the task. */
function dropServer (kill) {
  return new Promise(resolve => {
    const seen = []
    const srv = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url })
      req.resume()                       /* take the whole body first: the task is "created" */
      req.on('end', () => kill(req, res))
    })
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        base: `http://127.0.0.1:${srv.address().port}`,
        close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r) }),
      })
    })
  })
}

/* Send the client's request to the local server instead of kie.ai, keeping the path it chose. */
const onto = (base) => (url, opts) => NET(base + new URL(url).pathname + new URL(url).search, opts)

test('a 5xx on createTask issues exactly ONE POST', async () => {
  /* Not "it throws" - the count. A 5xx promises nothing about whether the task was created, so
     the second POST is the double bill, and only a count can see it. */
  const r = await capture(() => createTask('kling/v3', { prompt: 'yard to pool' }),
    () => json({ msg: 'upstream exploded' }, 500))
  assert.equal(r.ok, false)
  assert.equal(r.calls.length, 1,
    'a create must not be replayed on a 5xx - kie.ai has no idempotency key, so attempt two is a second billed render')
  assert.equal(r.calls[0].method, 'POST')
  assert.match(r.calls[0].url, /\/api\/v1\/jobs\/createTask$/)
  assert.match(r.e.message, /HTTP 500/)
})

test('createTask prints the recordInfo warning instead of failing silently', async () => {
  /* A create that quietly declines to retry looks exactly like any other transient blip, and the
     operator's next move is to re-run the whole step by hand - which is the bill the no-retry just
     avoided. The message has to name the escape hatch, not just apologise. */
  const r = await capture(() => createTask('kling/v3', { prompt: 'yard to pool' }),
    () => json({ msg: 'upstream exploded' }, 500))
  assert.equal(r.ok, false)
  assert.match(r.log, /NOT retried/)
  assert.match(r.log, /billable create/)
  assert.match(r.log, /recordInfo/, 'it has to say how to check whether the task landed')
  assert.match(r.log, /pay twice/)
})

test('a dropped socket on createTask still leaves exactly ONE task on the server', async () => {
  /* The likelier of the two double-bills, and the one the original mock demonstrated. The server
     has already taken the request - the task exists and will be billed - and then the connection
     dies. From the client that is indistinguishable from a request that never arrived, which is
     precisely why it must not be replayed.
     Verified against this server: fetch() itself rejects, the client reports `network error -
     fetch failed`, and the warning fires. */
  const s = await dropServer((req) => req.socket.destroy())
  try {
    const r = await capture(() => createTask('kling/v3', { prompt: 'yard to pool' }), onto(s.base))
    assert.equal(r.ok, false)
    assert.equal(s.seen.length, 1,
      'the server took the create once - a retry here bills a second render whose taskId we never learn')
    assert.equal(s.seen[0].method, 'POST')
    assert.equal(r.calls.length, 1)
    assert.match(r.e.message, /network error/)
    assert.match(r.log, /NOT retried/)
  } finally {
    await s.close()
  }
})

test('a socket dropped mid-response on createTask is not replayed either', async () => {
  /* The other half of the drop: headers arrived, the body was cut off. Observed rather than
     assumed - fetch() resolves here and `await res.text()` is what rejects, which is OUTSIDE the
     attempt loop, so the failure escapes as a bare TypeError('terminated') and no warning is
     printed. The count is what is being locked down; the warning deliberately is not asserted,
     because it does not fire on this path and a test should not claim otherwise.
     Note what this one is NOT: it holds with or without the `idempotent` flag, because the throw
     never reaches the attempt loop. Confirmed by running it against a copy of kie.mjs with the
     flag's two guards deleted - the other three create tests went red, this one stayed green. */
  const s = await dropServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '120' })
    res.write('{"code":200,"data":{"taskId":"t-')
    setTimeout(() => res.socket.destroy(), 10)
  })
  try {
    const r = await capture(() => createTask('kling/v3', { prompt: 'yard to pool' }), onto(s.base))
    assert.equal(r.ok, false)
    assert.equal(s.seen.length, 1, 'a truncated response is still a task the server created and will bill for')
    assert.equal(r.calls.length, 1)
  } finally {
    await s.close()
  }
})

test('a 429 on createTask IS retried, because nothing was created', async () => {
  /* The documented exception, and the reason the flag is not simply "never retry a create":
     rate-limited means the request was turned away before anything existed. Losing this would
     turn every burst into a hard failure mid-run. */
  const r = await capture(() => createTask('kling/v3', { prompt: 'yard to pool' }),
    (url, opts, n) => (n === 1 ? json({ msg: 'slow down' }, 429) : CREATED()))
  assert.ok(r.ok, `createTask threw: ${r.e && r.e.message}`)
  assert.equal(r.v, 'task-under-test')
  assert.equal(r.calls.length, 2, 'a 429 is safe to replay on a create and must stay replayed')
  assert.doesNotMatch(r.log, /NOT retried/)
  assert.match(r.log, /429 from kie\.ai, retrying/)
})

test('pollTask STILL retries a 5xx - a GET costs nothing to replay', async () => {
  /* The over-correction guard. "Do not retry" is right for exactly one call in this client, and a
     refactor that spreads it to the polls would make every run brittle for no saving at all -
     recordInfo is free. Nothing else in the suite would notice, so this asserts count > 1. */
  const r = await capture(() => pollTask('task-under-test', { label: 'clip 1' }),
    (url, opts, n) => (n === 1 ? json({ msg: 'bad gateway' }, 502) : DONE()))
  assert.ok(r.ok, `pollTask threw: ${r.e && r.e.message}`)
  assert.deepEqual(r.v, ['https://files.invalid/clip.mp4'])
  assert.ok(r.calls.length > 1, 'a poll must keep retrying - it is free, and giving up abandons a render already paid for')
  assert.equal(r.calls.length, 2)
  assert.equal(r.calls[0].method, 'GET')
  assert.match(r.calls[0].url, /\/api\/v1\/jobs\/recordInfo\?taskId=task-under-test$/)
  assert.doesNotMatch(r.log, /NOT retried/, 'the no-retry warning belongs to creates only')
})

test('uploadFile STILL retries a 5xx, capped at two attempts', async () => {
  /* An upload is free and creates nothing, so it retries - but `opts` is built once and reused, so
     every attempt re-sends the whole multi-megabyte body, which is why it is capped at two rather
     than the usual five. The 404 case is covered in kie-client.test.mjs; this is the other side of
     it, so the cap and the no-retry-on-create cannot be confused for the same rule. */
  const dir = tmpDir('ssh-retry-')
  const jpg = path.join(dir, 'photo.jpg')
  fs.writeFileSync(jpg, Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 0x11)]))
  const r = await capture(() => uploadFile(jpg), () => json({ msg: 'upstream exploded' }, 503))
  assert.equal(r.ok, false)
  assert.equal(r.calls.length, 2, 'two attempts: an upload is replayable, but re-sending the body five times is a minute of nothing')
  assert.doesNotMatch(r.log, /NOT retried/)
  assert.match(r.e.message, /HTTP 503/)
})
