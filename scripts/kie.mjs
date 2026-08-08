/* Shared kie.ai client.
   Everything else in this skill talks to kie.ai through here so the retry, throttle and
   result-parsing quirks live in exactly one place.

   The quirks worth knowing, each of which has bitten:
     1. createTask returning HTTP 200 only means the task was ACCEPTED. You must poll.
     2. kie.ai signals failures INSIDE a 200 response as {"code":401,...}. Checking res.ok is
        not enough - a bad key looks like success until you read the body.
     3. data.resultJson is a JSON *string*, not an object - parse it to reach resultUrls.
     4. Uploaded files are deleted after 24h, so re-upload anything older before using it.
     5. The file upload endpoint is not on the same host as everything else - see UPLOAD_BASE. */
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://api.kie.ai'

/* Read this before "fixing" the hostname below, because it looks exactly like a typo.
   The base64 upload route does not exist on api.kie.ai. Probed unauthenticated (free - a route
   that does not exist answers HTTP 404, a route that does answers quirk 2 above, an HTTP 200
   carrying code 401):
     POST https://api.kie.ai/api/v1/file-base64-upload      -> HTTP 404 Not Found
     POST https://api.kie.ai/api/file-base64-upload         -> HTTP 404 Not Found   (dropping /v1 is NOT the fix)
     POST https://kieai.redpandaai.co/api/file-base64-upload -> HTTP 200, body code 401 (route exists, auth required)
   The jobs API and the file host are two different services. Point uploads back at BASE and every
   run dies at its first network call with `HTTP 404 - No message available`. */
const UPLOAD_BASE = 'https://kieai.redpandaai.co'

/* No fetch in this client had a deadline, so a stalled multi-MB POST hung indefinitely and then
   hung again on every retry. undici's built-in defaults only rescue a dead socket, not a slow drip. */
const REQUEST_TIMEOUT_MS = 120000
const DOWNLOAD_TIMEOUT_MS = 300000   /* a rendered clip is bigger and slower than any JSON body */

export function requireKey () {
  const k = process.env.KIE_API_KEY
  if (!k) {
    console.error('KIE_API_KEY is not set. Run  node doctor.mjs  for per-platform instructions.')
    process.exit(1)
  }
  return k
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
/* One line of a response body, safe to put in an error message. */
const snip = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 200)
/* Accept is not decoration: without it the server's default decides whether we get JSON or an
   event stream, and kie.ai's own docs contradict themselves about what that default is. */
const headers = () => ({
  Authorization: `Bearer ${requireKey()}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
})

/* The documented limit is 20 new tasks per 10s. We stay well under it rather than racing to
   the edge - a 429 mid-run costs far more wall-clock than pacing does.

   The queue matters even though nothing here runs in parallel yet. Read-await-write on a shared
   `lastCreate` has an interleaving point in the middle of it, so N concurrent callers would all
   read the same slot, sleep the same interval and then fire in the same tick - pacing collapsing
   to nothing exactly when it is needed. Chaining reserves the slot before anyone awaits, so this
   stays correct the day someone wraps the segment loop in Promise.allSettled. */
let lastCreate = 0
let createGate = Promise.resolve()
function paceCreate () {
  const turn = createGate.then(async () => {
    const wait = lastCreate + 700 - Date.now()
    if (wait > 0) await sleep(wait)
    lastCreate = Date.now()
  })
  createGate = turn.catch(() => {})   /* one caller's failure must not wedge the queue shut */
  return turn
}

/* Errors carry .retryable so callers can tell "the network hiccuped" from "your key is wrong",
   and .body so a caller can inspect the code without re-parsing a message string. */
class KieError extends Error {
  constructor (msg, { retryable = false, status = 0, body = null } = {}) {
    super(msg); this.name = 'KieError'; this.retryable = retryable; this.status = status; this.body = body
  }
}

/* `idempotent` is the entire retry policy, and it exists because the two kinds of call in this
   client have opposite failure economics. A GET or a poll can be replayed for nothing, so it
   keeps the historical five attempts. A create cannot: kie.ai accepts no idempotency key, so a
   replayed create that the server had already accepted becomes a second billed render whose
   taskId we never learn - an orphan nobody collects and nobody sees. The bare network-error
   branch is the likelier way that happens, not the 5xx one: a request that reached the server
   and then lost the connection is indistinguishable from one that never arrived. */
async function req (url, opts, { retries = 4, label = '', idempotent = true } = {}) {
  const who = label || url
  let last = new KieError(`${who}: request never completed`)
  /* A create that is not retried must say so, or it reads like any other transient blip and the
     operator's next move is to re-run the whole step - which is the double bill we just avoided. */
  const noRetry = (e) => {
    console.error(`  NOT retried: ${who} is a billable create and kie.ai has no idempotency key.`)
    console.error('  The task MAY already exist. Query it with recordInfo before creating a replacement, or you pay twice.')
    return e
  }
  for (let i = 0; i <= retries; i++) {
    let res, body
    try {
      /* A fresh signal per attempt - a shared one would already be spent by the second try. */
      res = await fetch(url, { ...opts, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (e) {
      /* network-level: worth retrying, but never let the loop fall through with no error */
      last = new KieError(`${who}: network error - ${e.message}`, { retryable: true })
      if (!idempotent) throw noRetry(last)
      if (i < retries) { await sleep(1500 * 2 ** i); continue }
      throw last
    }
    if (res.status === 429 || res.status >= 500) {
      const backoff = Math.min(30000, 1500 * 2 ** i)
      last = new KieError(`${who}: HTTP ${res.status}`, { retryable: true, status: res.status })
      /* 429 is the one status safe to replay even on a create: rate limited means the request was
         turned away before anything was created. A 5xx promises nothing of the sort. */
      if (!idempotent && res.status !== 429) throw noRetry(last)
      if (i < retries) {
        console.warn(`  ${res.status} from kie.ai, retrying in ${Math.round(backoff / 1000)}s`)
        await sleep(backoff); continue
      }
      throw last
    }
    /* Read the body as text and parse it ourselves. res.json() throwing used to be swallowed into
       an empty object, which left res.ok true and body.code undefined, so an event stream, an HTML
       error page or a proxy interstitial arrived at the caller as `sol returned no text: {}` -
       blaming the model for a transport problem. Naming the content-type fixes that everywhere at
       once: upload, createTask and pollTask all report their own transport failures now. */
    const text = await res.text()
    let parsed = false
    body = {}
    if (text.trim()) { try { body = JSON.parse(text); parsed = true } catch (_) {} }

    if (!res.ok) {
      /* the HTTP status is the headline here whether or not the body parsed */
      throw new KieError(`${who}: HTTP ${res.status} - ${(parsed && (body.msg || body.message)) || snip(text) || 'empty body'}`,
        { status: res.status, body: parsed ? body : null })
    }
    if (!parsed) {
      throw new KieError(`${who}: expected a JSON response, got ${res.headers.get('content-type') || 'no content-type'}` +
        ` - ${snip(text) || 'empty body'}`, { status: res.status })
    }
    /* A 200 with a non-200 code in the body is kie.ai's way of reporting auth and quota
       problems. Treating it as success is what makes a bad key look fine in preflight and
       then spin pollTask for the full timeout. */
    if (body && body.code !== undefined && String(body.code) !== '200') {
      /* kie.ai's documented codes. Naming them beats echoing a bare number, because the two
         that actually happen mid-run - 402 and 429 - have completely different responses. */
      const MEANING = {
        401: 'unauthorised — check KIE_API_KEY',
        402: 'INSUFFICIENT CREDITS — top up at kie.ai before re-running; nothing was generated',
        404: 'not found',
        422: 'validation error — a parameter was rejected; check types (duration is a STRING)',
        429: 'rate limited — too many tasks created at once',
        433: 'sub-key usage limit exceeded',
        455: 'kie.ai is in maintenance',
        500: 'kie.ai server error',
        501: 'generation failed',
        505: 'this feature is currently disabled',
      }
      const hint = MEANING[Number(body.code)]
      throw new KieError(`${who}: kie.ai code ${body.code}${hint ? ' (' + hint + ')' : ''}` +
        `${body.msg ? ' - ' + body.msg : ''}`, { status: res.status, body })
    }
    return body
  }
  throw last
}

/* Sniff the real type from magic bytes. Trusting the extension mislabels a JPEG that has been
   copied to a .png name, and the upload endpoint believes whatever it is told.
   Anything we cannot recognise is rejected rather than guessed. The old fallback declared an
   unknown file image/png while still naming it .heic, so an iPhone photo went up advertising two
   different types at once and came back as a model-shaped error for a file-format problem. The
   returned mime and extension now always agree, because both come from the same sniff. */
function sniffMime (buf, filePath) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return ['image/jpeg', 'jpg']
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return ['image/png', 'png']
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return ['image/webp', 'webp']
  throw new KieError(
    `${path.basename(filePath)} is not a JPEG, PNG or WebP (first bytes: ${buf.subarray(0, 4).toString('hex')}).\n` +
    '  A HEIC straight off an iPhone is the usual cause. Convert it first - ffmpeg is already\n' +
    '  required by this skill:\n' +
    `    ffmpeg -i "${filePath}" -q:v 3 converted.jpg`)
}

/* A photo, not a video. base64 inflates whatever we read by a third, JSON.stringify holds a
   second copy of that, and the UTF-8 wire encoding a third - so a 10 MB file is already ~40 MB
   of live memory in one request. A phone or DSLR photo is 2-10 MB, so this cap only fires on
   something that should have been downscaled, and failing here costs nothing. There is
   deliberately no image library behind this: the cap and the message are the whole fix. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/* Local file -> hosted URL. Kling and GPT Image take URLs, never local paths or inline base64.
   NOTE: the host deletes these after 24h - see freshUrl() below. */
export async function uploadFile (filePath) {
  const buf = fs.readFileSync(filePath)
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new KieError(
      `${path.basename(filePath)} is ${(buf.length / 1048576).toFixed(1)} MB, over the ` +
      `${MAX_UPLOAD_BYTES / 1048576} MB upload limit.\n` +
      '  Downscale it first - ffmpeg is already required by this skill:\n' +
      `    ffmpeg -i "${filePath}" -vf scale=2048:-2 -q:v 3 downscaled.jpg`)
  }
  const [mime, ext] = sniffMime(buf, filePath)
  const base = path.basename(filePath, path.extname(filePath))
  /* UPLOAD_BASE, not BASE - see the constant. This is the one route on the other host. */
  const body = await req(`${UPLOAD_BASE}/api/file-base64-upload`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      base64Data: `data:${mime};base64,${buf.toString('base64')}`,
      uploadPath: 'images',
      fileName: `${base}.${ext}`,
    }),
    /* Two attempts, not five: `opts` is built once and reused, so every retry re-sends the whole
       multi-megabyte body. Upload is free, but five blind attempts is a minute of nothing. */
  }, { label: `upload ${path.basename(filePath)}`, retries: 1 })
  const url = body?.data?.fileUrl || body?.data?.url || body?.data?.downloadUrl || body?.fileUrl
  if (!url) throw new KieError('upload returned no fileUrl: ' + JSON.stringify(body).slice(0, 300))
  return { url, uploadedAt: Date.now() }
}

/* kie.ai deletes uploads after 24h. An approval gate is *designed* to take longer than a
   coffee break, so anything uploaded before the gate must be re-uploaded after it or Kling
   silently receives dead URLs. Callers pass whatever they have on record. */
const UPLOAD_TTL_MS = 20 * 60 * 60 * 1000   /* 20h, comfortably inside the 24h window */
export async function freshUrl (rec, filePath) {
  if (rec && rec.url && rec.uploadedAt && Date.now() - rec.uploadedAt < UPLOAD_TTL_MS) return rec
  if (!filePath || !fs.existsSync(filePath)) {
    throw new KieError(`upload for ${filePath || 'unknown file'} has expired and the local copy is gone - regenerate it`)
  }
  return uploadFile(filePath)
}

export async function createTask (model, input, extra = {}) {
  await paceCreate()
  const body = await req(`${BASE}/api/v1/jobs/createTask`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ model, input, ...extra }),
    /* The one non-idempotent call in the client - see req(). */
  }, { label: `createTask ${model}`, idempotent: false })
  const id = body?.data?.taskId
  if (!id) throw new KieError('createTask returned no taskId: ' + JSON.stringify(body).slice(0, 300))
  return id
}

/* Poll to completion. Returns resultUrls[]. Throws with failMsg on a failed task so the caller
   can retry that one item rather than the whole batch.

   onMeta receives the finished task record - the only place kie.ai reports creditsConsumed.
   Callers use it to record what a run actually cost and reconcile that against what they
   estimated. It was accepted by two callers and never invoked here, so every gate promising
   "this run compares the real figure against the estimate" was making a promise the client could
   not keep: precisely the defect this repo was audited for. Success only - a failed task is not
   billed, and reporting a charge that did not happen is its own wrong number. A throwing callback
   must not lose the URLs the caller already paid for, so it is isolated. */
export async function pollTask (taskId, { timeoutMs = 600000, label = '', onMeta = null } = {}) {
  const t0 = Date.now()
  let lastState = ''
  while (Date.now() - t0 < timeoutMs) {
    const body = await req(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
      { headers: headers() }, { label: `poll ${label || taskId}` })
    const d = body?.data || {}
    if (d.state && d.state !== lastState) {
      lastState = d.state
      process.stdout.write(`  ${label} ${d.state}${d.progress ? ' ' + d.progress + '%' : ''}\n`)
    }
    if (d.state === 'success') {
      let parsed = {}
      try { parsed = typeof d.resultJson === 'string' ? JSON.parse(d.resultJson) : (d.resultJson || {}) } catch (_) {}
      const urls = parsed.resultUrls || parsed.result_urls || []
      if (!urls.length) throw new KieError(`task ${taskId} succeeded but returned no resultUrls`)
      if (typeof onMeta === 'function') {
        try { onMeta(d) } catch (e) {
          console.error(`  (recording the cost of ${label || taskId} failed: ${e.message} - the ` +
            'generation itself succeeded and is not affected)')
        }
      }
      return urls
    }
    if (d.state === 'fail') {
      throw new KieError(`task ${taskId} failed: ${d.failCode || ''} ${d.failMsg || ''}`.trim(), { body })
    }
    await sleep(5000)
  }
  throw new KieError(`task ${taskId} timed out after ${Math.round(timeoutMs / 1000)}s. It may STILL BE RUNNING - ` +
    `query it with recordInfo before creating a replacement, or you pay twice.`)
}

/* 200 MB leaves plenty of room for a 4K clip while still stopping a mis-pointed or runaway URL
   from filling the disk. Checked against the bytes as they arrive, not only against
   Content-Length, because that header can be absent or wrong. */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

export async function download (url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok) throw new KieError(`download failed ${res.status} for ${url}`)
  if (!res.body) throw new KieError(`download for ${path.basename(dest)} returned an empty body`)
  const tooBig = (n) => new KieError(
    `download for ${path.basename(dest)} is ${(n / 1048576).toFixed(1)} MB, over the ` +
    `${MAX_DOWNLOAD_BYTES / 1048576} MB limit - refusing. Check the URL before raising the cap.`)
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw tooBig(declared)
  const chunks = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > MAX_DOWNLOAD_BYTES) throw tooBig(total)
    chunks.push(chunk)
  }
  fs.writeFileSync(dest, Buffer.concat(chunks))
  return dest
}

/* Sol is NOT a jobs/createTask model - it is a Responses-style endpoint that answers inline. */
export async function sol (messages, { effort = 'medium', model = 'gpt-5-6-sol' } = {}) {
  const body = await req(`${BASE}/codex/v1/responses`, {
    method: 'POST', headers: headers(),
    /* stream:false is stated rather than assumed. kie.ai's schema says the default is false and
       its prose alongside says true; sending it means the answer no longer matters, and an
       event-stream reply would be a transport error we can name instead of an empty body. */
    body: JSON.stringify({ model, input: messages, stream: false, reasoning: { effort } }),
  }, { label: 'sol' })
  const out = (body?.output || [])
    .flatMap(o => o?.content || [])
    .filter(c => c?.type === 'output_text')
    .map(c => c.text).join('\n').trim()
  if (!out) throw new KieError('sol returned no text: ' + JSON.stringify(body).slice(0, 400))
  return out
}

/* ---------- small shared helpers ---------- */

export const state = {
  /* A corrupt state file must not read as "nothing has been generated" - that silently
     re-pays for everything. Missing is fine; unreadable is an error the user should see. */
  load (file) {
    if (!fs.existsSync(file)) return {}
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      console.error(`\n${file} exists but is not valid JSON (${e.message}).`)
      console.error('Refusing to continue, because treating it as empty would re-generate and')
      console.error('re-bill everything already produced. Inspect or delete it, then re-run.\n')
      process.exit(1)
    }
  },
  save (file, obj) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    /* write-then-rename so an interrupt cannot leave a half-written state file */
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
    fs.renameSync(tmp, file)
  },
}

/* Accepts --flag value AND --flag=value. Only supporting the first form meant --mode=std was
   silently dropped and the run billed at the pro default.

   Everything else in here exists because this parser stands directly in front of paid calls, and
   every way it could guess has already gone wrong in a way nothing downstream could catch:
     --idea --steps 6        gave idea the boolean true, storyboard.mjs's `if (!a.idea)` guard
                             passed because true is truthy, and kie.ai was paid to storyboard the
                             literal prompt "Idea: true"
     --idea bare yard to pool  was truncated to "bare" and paid for that - the same mistake, one
                             missing pair of quotes away, and the easy one to make in PowerShell
     --steps                 became NaN, which the prompt rendered as "exactly NaN steps"
     --budget-mb             became NaN, and `mb > NaN` is false for every mb, so the page-weight
                             guard reported PASS while switched off
   So nothing is guessed here. A flag that takes a value and has none is an error, a stray bare
   word is an error, and the flags whose values have a shape are checked at this boundary - the
   one place all four scripts share - instead of in four separate parseInt calls.

   Values stay strings, exactly as the call sites already expect them (`parseInt(a.steps || '6')`);
   this validates them, it does not retype them. */
const BOOLEAN_FLAGS = ['yes', 'help']            /* the only flags that legitimately carry no value */
const NUMERIC_FLAGS = ['steps', 'duration', 'width', 'per-clip', 'quality', 'budget-mb']
export function args (argv = process.argv.slice(2), { booleans = [], numbers = [] } = {}) {
  /* A script that adds its own value-less flag passes it in `booleans` rather than editing the
     shared table above - e.g. args(process.argv.slice(2), { booleans: ['allow-gaps'] }). */
  const isBool = (k) => BOOLEAN_FLAGS.includes(k) || booleans.includes(k)
  const isNum = (k) => NUMERIC_FLAGS.includes(k) || numbers.includes(k)
  const die = (msg) => { console.error(msg); process.exit(1) }
  const o = Object.create(null)   /* null prototype so --constructor cannot shadow an inherited key */

  const set = (k, v) => {
    /* Last-flag-wins is what every naive parser does and the documented form is comma-separated
       anyway (--only 3,5), so warn rather than refuse - but never drop a value in silence. */
    if (k in o) console.warn(`  --${k} was given more than once; using the last value ("${v}")`)
    if (isNum(k) && (!v.trim() || !Number.isFinite(Number(v)))) {
      die(`--${k} must be a number, got "${v}"`)
    }
    if (k === 'only' && !/^\d+(\s*,\s*\d+)*$/.test(v)) {
      die(`--only takes step numbers, e.g. --only 3 or --only "3,5"; got "${v}"`)
    }
    /* --var becomes a JavaScript identifier in generated source (window.<var>_SEQ). The sink is
       in build-frames.mjs, but this is the boundary the value enters through, so it is checked
       here too - `--var hero-scroll` would otherwise emit invalid JS, print a success summary,
       exit 0, and leave a dead hero on the live page. */
    if (k === 'var' && !/^[A-Za-z_$][\w$]*$/.test(v)) {
      die(`--var must be a JavaScript identifier (letters, digits, _ and $, not starting with a digit); got "${v}"`)
    }
    o[k] = v
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) {
      die(`unexpected argument "${tok}" - a multi-word value must be quoted, e.g. --idea "bare yard to finished pool"`)
    }
    const eq = tok.indexOf('=')
    const k = tok.slice(2, eq === -1 ? undefined : eq)
    if (!/^[A-Za-z][\w-]*$/.test(k)) die(`"${tok}" is not a valid flag name`)
    if (eq !== -1) {
      /* --yes=false must not read as consent. A spend gate is not the place to be relaxed about
         truthiness, and `!!'false'` is true. */
      if (isBool(k)) { o[k] = !/^(false|0|no|off)$/i.test(tok.slice(eq + 1)); continue }
      set(k, tok.slice(eq + 1)); continue
    }
    if (isBool(k)) { o[k] = true; continue }
    /* A value that looks like a flag is a missing value, not a value. */
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      die(`--${k} needs a value${next === undefined ? '' : ` (got the flag "${next}")`}`)
    }
    set(k, argv[++i])
  }
  return o
}

/* Confirmation that works when nobody is at a keyboard.
   Claude, CI and any piped shell run with stdin closed; a readline prompt there dies with an
   unsettled-await warning and exit 13, having done nothing. So: ask when a human is present,
   and otherwise refuse clearly and tell them the flag that means yes. */
export async function confirm (question, { yes = false, whatItCosts = '' } = {}) {
  if (yes) return true
  if (!process.stdin.isTTY) {
    console.error('\nThis step spends credits and needs confirmation, but stdin is not interactive')
    console.error('(that is normal when Claude, CI or a pipe is running the command).')
    if (whatItCosts) console.error(whatItCosts)
    console.error('\nRe-run with  --yes  to confirm you want to spend, e.g.:')
    console.error(`  ${process.argv.slice(1).map(s => /\s/.test(s) ? `"${s}"` : s).join(' ')} --yes\n`)
    return false
  }
  const readline = await import('node:readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ans = await new Promise(r => rl.question(`${question} [y/N] `, r))
  rl.close()
  return /^y(es)?$/i.test(String(ans).trim())
}
