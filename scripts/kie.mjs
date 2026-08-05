/* Shared kie.ai client.
   Everything else in this skill talks to kie.ai through here so the retry, throttle and
   result-parsing quirks live in exactly one place.

   The quirks worth knowing, each of which has bitten:
     1. createTask returning HTTP 200 only means the task was ACCEPTED. You must poll.
     2. kie.ai signals failures INSIDE a 200 response as {"code":401,...}. Checking res.ok is
        not enough - a bad key looks like success until you read the body.
     3. data.resultJson is a JSON *string*, not an object - parse it to reach resultUrls.
     4. Uploaded files are deleted after 24h, so re-upload anything older before using it. */
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'https://api.kie.ai'

export function requireKey () {
  const k = process.env.KIE_API_KEY
  if (!k) {
    console.error('KIE_API_KEY is not set. Run  node doctor.mjs  for per-platform instructions.')
    process.exit(1)
  }
  return k
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const headers = () => ({ Authorization: `Bearer ${requireKey()}`, 'Content-Type': 'application/json' })

/* The documented limit is 20 new tasks per 10s. We stay well under it rather than racing to
   the edge - a 429 mid-run costs far more wall-clock than pacing does. */
let lastCreate = 0
async function paceCreate () {
  const wait = lastCreate + 700 - Date.now()
  if (wait > 0) await sleep(wait)
  lastCreate = Date.now()
}

/* Errors carry .retryable so callers can tell "the network hiccuped" from "your key is wrong",
   and .body so a caller can inspect the code without re-parsing a message string. */
class KieError extends Error {
  constructor (msg, { retryable = false, status = 0, body = null } = {}) {
    super(msg); this.name = 'KieError'; this.retryable = retryable; this.status = status; this.body = body
  }
}

async function req (url, opts, { retries = 4, label = '' } = {}) {
  let last = new KieError(`${label || url}: request never completed`)
  for (let i = 0; i <= retries; i++) {
    let res, body
    try {
      res = await fetch(url, opts)
    } catch (e) {
      /* network-level: worth retrying, but never let the loop fall through with no error */
      last = new KieError(`${label || url}: network error - ${e.message}`, { retryable: true })
      if (i < retries) { await sleep(1500 * 2 ** i); continue }
      throw last
    }
    if (res.status === 429 || res.status >= 500) {
      const backoff = Math.min(30000, 1500 * 2 ** i)
      last = new KieError(`${label || url}: HTTP ${res.status}`, { retryable: true, status: res.status })
      if (i < retries) {
        console.warn(`  ${res.status} from kie.ai, retrying in ${Math.round(backoff / 1000)}s`)
        await sleep(backoff); continue
      }
      throw last
    }
    try { body = await res.json() } catch (_) { body = {} }

    if (!res.ok) {
      throw new KieError(`${label || url}: HTTP ${res.status} - ${(body && (body.msg || body.message)) || JSON.stringify(body).slice(0, 200)}`,
        { status: res.status, body })
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
      throw new KieError(`${label || url}: kie.ai code ${body.code}${hint ? ' (' + hint + ')' : ''}` +
        `${body.msg ? ' - ' + body.msg : ''}`, { status: res.status, body })
    }
    return body
  }
  throw last
}

/* Sniff the real type from magic bytes. Trusting the extension mislabels a JPEG that has been
   copied to a .png name, and the upload endpoint believes whatever it is told. */
function sniffMime (buf, fallbackExt = 'png') {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return ['image/jpeg', 'jpg']
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return ['image/png', 'png']
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return ['image/webp', 'webp']
  return [fallbackExt === 'jpg' || fallbackExt === 'jpeg' ? 'image/jpeg' : 'image/png', fallbackExt]
}

/* Local file -> hosted URL. Kling and GPT Image take URLs, never local paths or inline base64.
   NOTE: the host deletes these after 24h - see freshUrl() below. */
export async function uploadFile (filePath) {
  const buf = fs.readFileSync(filePath)
  const [mime, ext] = sniffMime(buf, path.extname(filePath).slice(1).toLowerCase())
  const base = path.basename(filePath, path.extname(filePath))
  const body = await req(`${BASE}/api/v1/file-base64-upload`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      base64Data: `data:${mime};base64,${buf.toString('base64')}`,
      uploadPath: 'images',
      fileName: `${base}.${ext}`,
    }),
  }, { label: `upload ${path.basename(filePath)}` })
  const url = body?.data?.fileUrl || body?.data?.url || body?.fileUrl
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
  }, { label: `createTask ${model}` })
  const id = body?.data?.taskId
  if (!id) throw new KieError('createTask returned no taskId: ' + JSON.stringify(body).slice(0, 300))
  return id
}

/* Poll to completion. Returns resultUrls[]. Throws with failMsg on a failed task so the caller
   can retry that one item rather than the whole batch. */
export async function pollTask (taskId, { timeoutMs = 600000, label = '' } = {}) {
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

export async function download (url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new KieError(`download failed ${res.status} for ${url}`)
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
  return dest
}

/* Sol is NOT a jobs/createTask model - it is a Responses-style endpoint that answers inline. */
export async function sol (messages, { effort = 'medium', model = 'gpt-5-6-sol' } = {}) {
  const body = await req(`${BASE}/codex/v1/responses`, {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ model, input: messages, reasoning: { effort } }),
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
   silently dropped and the run billed at the pro default. */
export function args (argv = process.argv.slice(2)) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('--')) continue
    const eq = tok.indexOf('=')
    if (eq !== -1) { o[tok.slice(2, eq)] = tok.slice(eq + 1); continue }
    const k = tok.slice(2)
    o[k] = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true
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
