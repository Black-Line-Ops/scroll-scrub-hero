/* Preflight. Run this first, and whenever something is behaving oddly.
   Everything this checks is a thing that otherwise fails deep inside a run, often after
   money has been spent - so it is worth the ten seconds. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ok = (m) => console.log(`  OK    ${m}`)
const bad = (m, fix) => { console.log(`  MISS  ${m}`); if (fix) console.log(`        ${fix}`); return 1 }
/* Something answered, but not what we expected. Worth printing and not worth failing on: the
   route clearly exists, and preflight cannot judge further without spending money to find out. */
const note = (m, extra) => { console.log(`  NOTE  ${m}`); if (extra) console.log(`        ${extra}`) }
let problems = 0

/* Shared by every network check below. Short on purpose - this script promises ten seconds. */
const PROBE_TIMEOUT_MS = 15000

console.log('\nscroll-scrub-hero preflight\n')

/* --- node --- */
const major = parseInt(process.versions.node.split('.')[0], 10)
if (major >= 18) ok(`Node ${process.versions.node}`)
else problems += bad(`Node ${process.versions.node} is too old (need 18+ for built-in fetch)`,
  'Install a current Node from nodejs.org, then reopen your terminal.')

/* --- ffmpeg + ffprobe --- */
let haveFfmpeg = false
for (const bin of ['ffmpeg', 'ffprobe']) {
  try {
    const v = execFileSync(bin, ['-version'], { encoding: 'utf8' }).split('\n')[0]
    if (bin === 'ffmpeg') haveFfmpeg = true
    ok(v.slice(0, 60))
  } catch (_) {
    problems += bad(`${bin} not found on PATH`,
      os.platform() === 'win32'
        ? 'winget install Gyan.FFmpeg     (then reopen your terminal)'
        : os.platform() === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install ffmpeg')
  }
}

/* --- can that ffmpeg actually encode WebP? ---
   Having the binary is not the check that matters. build-frames.mjs hard-codes `-c:v libwebp`
   with no fallback and no second output format, and it is step 4 of 4 - downstream of the
   storyboard, every keyframe and every tween - so an ffmpeg without libwebp fails only once the
   entire run has been paid for. This is not hypothetical: a Homebrew build with 202 encoders and
   no WebP is what turned up the finding.
   The match is anchored to the ENCODER-NAME column - the second whitespace-separated field of a
   row - and a word boundary anywhere in the line is NOT enough. Real ffmpeg 8.1.1 on Windows
   prints both of these:
       V....D libwebp_anim         libwebp WebP image (codec webp)
       V....D libwebp              libwebp WebP image (codec webp)
   The anim row's DESCRIPTION column carries the standalone token "libwebp", so the older
   /\blibwebp\b/ matched it: fed an anim-only listing, this script printed
   "OK    ffmpeg can encode WebP (libwebp)" and certified a build that cannot run build-frames.mjs,
   which hard-codes `-c:v libwebp` (build-frames.mjs:232) and will not accept libwebp_anim.
   The regex below was run through this script against three listings: real ffmpeg 8.1.1 output
   (OK), a listing holding only the libwebp_anim row (MISS), and one holding neither (MISS). */
if (haveFfmpeg) {
  try {
    const encoders = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
    if (/^\s*\S+\s+libwebp\s/m.test(encoders)) {
      ok('ffmpeg can encode WebP (libwebp)')
    } else {
      const install = os.platform() === 'win32'
        ? 'winget install Gyan.FFmpeg     (the Gyan builds carry libwebp; then reopen your terminal)'
        : os.platform() === 'darwin'
          ? 'brew reinstall ffmpeg     (some bottles ship without it - if so, use the static build from evermeet.cx/ffmpeg)'
          : 'sudo apt install ffmpeg     (distro builds vary - otherwise a static build from johnvansickle.com/ffmpeg)'
      const verify = os.platform() === 'win32'
        ? 'then check it took:  ffmpeg -hide_banner -encoders | findstr /i webp'
        : 'then check it took:  ffmpeg -hide_banner -encoders | grep -i webp'
      /* That listing prints libwebp_anim as well, and on a build with only the animation encoder
         it is the ONLY thing it prints - so the command on its own reads like a pass. Say which
         row counts, or this hint repeats the bug the check above was just fixed for. */
      const which = 'you need a row whose name column is exactly  libwebp  - libwebp_anim is a different encoder'
      problems += bad('this ffmpeg has no libwebp encoder - build-frames.mjs cannot write the frame sequence',
        `${install}\n        ${verify}\n        ${which}`)
    }
  } catch (e) {
    problems += bad(`could not list ffmpeg's encoders (${e.message})`,
      'Unusual - run  ffmpeg -hide_banner -encoders  by hand and look for libwebp.')
  }
}

/* --- the API key ---
   Enough of the key to tell two of them apart, and not one character more. Doctor output is the
   first thing anyone pastes into a bug report, so the tail is gone: the leading characters are
   what identify which key is loaded and what expose a stray quote or space, which is the whole of
   what this line owes the user. The length stays because a key that is one character short is a
   real and otherwise invisible paste error.
   The short branch is not politeness. slice(0,4) and slice(-4) OVERLAP at eight characters or
   fewer, so the old mask printed short keys in full - a line whose entire job is to withhold
   characters, withholding none. Anything that short is a truncated paste rather than a live
   credential, and saying so is more useful than showing it. */
const mask = (k) => k.length <= 12 ? '(too short - looks like a truncated paste)' : `${k.slice(0, 4)}…`

if (process.env.KIE_API_KEY) {
  const k = process.env.KIE_API_KEY
  ok(`KIE_API_KEY is set (${mask(k)}, ${k.length} chars)`)
} else {
  problems += bad('KIE_API_KEY is not set', 'See "Setting your key" below.')
}

/* --- is the key actually good? only worth asking if one is present --- */
if (process.env.KIE_API_KEY) {
  try {
    const res = await fetch('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=preflight-probe', {
      headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}` },
      /* A preflight that hangs is worse than one that fails: the whole promise of this script is
         that it costs ten seconds. A captive-portal proxy will happily accept the socket forever. */
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    let body = {}
    try { body = await res.json() } catch (_) {}
    /* kie.ai reports auth failures INSIDE a 200 response as {"code":401,...}. Checking
       res.status alone passes a dead key straight through preflight, which then fails much
       later and much more confusingly. Read the body code as well as the HTTP status. */
    const bodyCode = body && body.code !== undefined ? String(body.code) : null
    const authFailed = res.status === 401 || bodyCode === '401' || bodyCode === '403'
    if (authFailed) {
      problems += bad(`kie.ai rejected the key (HTTP ${res.status}, body code ${bodyCode ?? 'none'}${body.msg ? ' - ' + body.msg : ''})`,
        'Check for a stray space or quote, and that the key is still active at kie.ai -> API keys.')
    } else if (bodyCode && !['200', '404', '422'].includes(bodyCode)) {
      /* 404/422 are the expected answers to a deliberately bogus task id - anything else is
         worth surfacing rather than calling healthy (quota and billing land here). */
      problems += bad(`kie.ai answered with code ${bodyCode}${body.msg ? ' - ' + body.msg : ''}`,
        'Often a credit/quota problem on the account. Check your balance at kie.ai.')
    } else {
      ok(`kie.ai reachable and the key was accepted (probe returned ${bodyCode ?? res.status} for a bogus task id, as expected)`)
    }
  } catch (e) {
    problems += bad(`could not reach api.kie.ai (${e.message})`, 'Check your connection, VPN or proxy.')
  }
}

/* --- do the routes this pipeline calls still exist? ---
   The key probe above touches recordInfo, which is the one route of the four that is never the
   first thing a run reaches. So preflight used to print "All good. Start with:" above a command
   that died at its very first network call. A green preflight is a positive assertion; getting it
   wrong is worse than not checking, because it sends the user looking in the wrong place.

   What this catches is a stale route table - the breakage a skill pinned to somebody else's API
   actually ships with. Uploads are not even on the same host as the jobs API (see kie.mjs's
   UPLOAD_BASE), which is exactly the sort of detail that quietly goes out of date. A route that
   exists answers `code: 401` unauthenticated; a route that has moved answers HTTP 404. So the two
   are distinguishable with no credentials at all.

   These requests deliberately send NO Authorization header. That is not only what makes them free
   - it is what makes them safe. A keyed POST to createTask is a render someone pays for; preflight
   must never be the thing that spends.

   Keep this list in step with scripts/kie.mjs. It is duplicated rather than imported because
   kie.mjs exports no base URLs; if those move, move these too. A preflight testing a different
   route table from the client's is worse than no preflight at all. */
const ROUTES = [
  ['upload host', 'POST', 'https://kieai.redpandaai.co/api/file-base64-upload'],
  ['createTask', 'POST', 'https://api.kie.ai/api/v1/jobs/createTask'],
  ['Sol responses', 'POST', 'https://api.kie.ai/codex/v1/responses'],
  ['recordInfo', 'GET', 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=preflight-probe'],
]

async function probeRoute (method, url) {
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    /* Read as text and parse here, the same way kie.mjs does: res.json() throwing on an HTML
       interstitial would look identical to a missing route, and those want different advice. */
    let body = null
    try { body = JSON.parse(await res.text()) } catch (_) {}
    return { status: res.status, body }
  } catch (e) {
    return { error: e.message }
  }
}

/* No fetch means a Node older than 18, which the check at the top of this file has already said
   in one clear line. Four more MISS lines underneath it would only bury the real answer. */
if (typeof fetch === 'function') {
  /* Fired together rather than in sequence: on an offline machine four sequential probes would
     each pay the full timeout, and the ten-second promise turns into a minute. */
  const results = await Promise.all(ROUTES.map(([, method, url]) => probeRoute(method, url)))
  ROUTES.forEach(([name, method, url], i) => {
    const r = results[i]
    const bodyCode = r.body && r.body.code !== undefined ? String(r.body.code) : null
    if (r.error) {
      problems += bad(`could not reach the ${name} route (${r.error})`, 'Check your connection, VPN or proxy.')
    } else if (r.status === 404 || bodyCode === '404') {
      problems += bad(`the ${name} route is GONE - ${method} ${url} answered 404`,
        'kie.ai has moved or renamed it, so this skill is pinned to a stale route table.\n' +
        '        Check kie.ai\'s current API docs, then update the URL in scripts/kie.mjs.')
    } else if (!r.body) {
      /* A route that exists answers JSON. HTML here means something in the middle - a captive
         portal, a corporate proxy, an interstitial - is answering on kie.ai's behalf. */
      problems += bad(`the ${name} route answered HTTP ${r.status} but not JSON`,
        'Something between you and kie.ai is intercepting the request (proxy, VPN or captive portal).')
    } else if (r.status === 401 || r.status === 403 || bodyCode === '401' || bodyCode === '403') {
      ok(`${name} route exists (unauthenticated ${method} was refused with 401, as expected)`)
    } else {
      note(`${name} route answered HTTP ${r.status}, code ${bodyCode ?? 'none'} to an unauthenticated ${method}`,
        'The route is there, which is what this check is for - but that is not the usual answer.')
    }
  })
}

/* --- writable scratch --- */
try {
  const p = path.join(process.cwd(), '.scrub-hero-writetest')
  fs.writeFileSync(p, 'x'); fs.rmSync(p)
  ok(`current directory is writable (${process.cwd()})`)
} catch (_) {
  problems += bad('current directory is not writable', 'cd somewhere you own and re-run.')
}

console.log()
if (!problems) {
  console.log('All good. Start with:\n')
  console.log('  node storyboard.mjs --ref "path/to/photo.jpg" --idea "what transforms" --steps 6\n')
} else {
  console.log(`${problems} thing(s) to fix before running the pipeline.\n`)
  if (!process.env.KIE_API_KEY) {
    console.log('Setting your key')
    console.log('  Get one at kie.ai -> API keys (you need credits on the account).\n')
    console.log('  Windows PowerShell, just this terminal:')
    console.log('    $env:KIE_API_KEY = "sk-your-key"\n')
    console.log('  Windows PowerShell, permanently (reopen the terminal afterwards):')
    console.log('    [Environment]::SetEnvironmentVariable("KIE_API_KEY","sk-your-key","User")\n')
    console.log('  macOS / Linux / Git Bash, just this shell:')
    console.log('    export KIE_API_KEY="sk-your-key"\n')
    console.log('  macOS / Linux, permanently:')
    console.log('    echo \'export KIE_API_KEY="sk-your-key"\' >> ~/.zshrc   # or ~/.bashrc\n')
    console.log('  Keep it out of any repo. These scripts only ever read it from the environment.')
  }
}
/* exitCode, not exit(). On Windows, `process.exit()` after a fetch trips a libuv assertion -
   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c` - which prints
   below the summary and replaces the exit code with 127. Reproduced on Node 24.15.0 with a single
   fetch and nothing else. It was already latent here (it fired whenever a key was set); the route
   probes above would have made it fire on every run. Setting the code and letting the loop drain
   avoids it and costs nothing measurable - undici's sockets are unref'd, so we still exit at once. */
process.exitCode = problems ? 1 : 0
