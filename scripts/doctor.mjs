/* Preflight. Run this first, and whenever something is behaving oddly.
   Everything this checks is a thing that otherwise fails deep inside a run, often after
   money has been spent - so it is worth the ten seconds.

   The last section is the money view, and it is here for the same reason as the rest: the balance,
   the rate table and the size of a default run are three facts that only matter together, and the
   moment they are worth having is before anything has been ordered. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ok = (m) => console.log(`  OK    ${m}`)
const bad = (m, fix) => { console.log(`  MISS  ${m}`); if (fix) console.log(`        ${fix}`); return 1 }
/* Something answered, but not what we expected. Worth printing and not worth failing on: the
   route clearly exists, and preflight cannot judge further without spending money to find out.
   `label` exists so a line that is bad news rather than a curiosity can say WARN while staying in
   the same printed-but-not-fatal lane. It is a parameter rather than a fourth printer on purpose:
   test/doctor-mask.test.mjs scans every `ok(`, `bad(` and `note(` call site for anything
   key-shaped, and a new function name would quietly fall outside that guard. */
const note = (m, extra, label = 'NOTE') => { console.log(`  ${label}  ${m}`); if (extra) console.log(`        ${extra}`) }
let problems = 0

/* Shared by every network check below. Short on purpose - this script promises ten seconds.
   One exception, and it is deliberate: the balance lookup keeps pricing.mjs's shorter 8s deadline,
   because it is the one request here preflight is allowed to finish without. See it below. */
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
  /* Not a route the pipeline spends through - it is pricing.mjs's BALANCE_URL, duplicated for the
     same reason the four above are duplicated from kie.mjs: it is module-private there. It earns
     its place because a balance that comes back "unavailable" is deliberately not fatal, and this
     row is what tells the user whether that was the endpoint moving or their key.
     Probed unauthenticated while this row was added (2026-08-07): it answers HTTP 200 with body
     code 401. The control is what makes that meaningful - the neighbouring /api/v1/common/credit
     answers a real HTTP 404 - so a 404 here would mean the route had genuinely moved. */
  ['credit balance', 'GET', 'https://api.kie.ai/api/v1/chat/credit'],
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

/* pricing.mjs is imported DYNAMICALLY and its absence is survivable, for two reasons pointing the
   same way. This script is the first thing anyone runs, and a diagnostic that dies with a
   module-resolution stack trace has failed at the only job it has: a missing file is something
   preflight REPORTS, not something it throws. And it keeps doctor.mjs stageable the way the test
   harness stages the other scripts - into a temp directory holding only itself and a stub kie.mjs
   - which a static import would make impossible. Same pattern, and same reasoning, as
   keyframes.mjs and tween.mjs. */
let pricing = null
let pricingProblem = ''
try {
  pricing = await import('./pricing.mjs')
} catch (e) {
  pricingProblem = e && e.code === 'ERR_MODULE_NOT_FOUND'
    ? 'pricing.mjs is not next to this script'
    : `pricing.mjs did not load (${(e && e.message) || e})`
}

/* The rate table, loaded QUIETLY: a rejected override is printed further down in this script's own
   vocabulary rather than as a stray stderr line above the checks. Loading it here also means the
   money view below is priced against the same table the rest of the pipeline will use, overrides
   and all - a preflight quoting different numbers from the run would be worse than none. */
const rates = pricing ? pricing.loadRates({ quiet: true }) : null

/* Started here, awaited at the bottom, so it overlaps the route probes instead of adding a round
   trip after them - preflight promises ten seconds and this is one more request to the same host.
   It cannot throw (fetchBalance degrades to {known:false, reason}) and it cannot spend (it is a
   GET of a balance), so there is nothing for the await to guard.
   It keeps pricing.mjs's shorter 8s deadline rather than this file's 15s, deliberately: it is the
   one check here that preflight is allowed to finish without, so it should be first to give up. */
const balanceLookup = pricing ? pricing.fetchBalance({ rates }) : null

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

/* --- the money view ---
   Everything above asks whether the pipeline CAN run. This asks what it will cost when it does,
   and whether the account can cover it.

   The worst failure this pipeline has is not a crash. It is running dry halfway: kie.ai has been
   paid for the stills and segments that finished, the run has no hero to show for them, and the
   money is gone. Restarting re-orders whatever state.json could not resume. That is exactly the
   class of thing a preflight is for, and it is only catchable here, where the balance, the rates
   and the size of a default run are all in scope at once.

   Nothing in this section can spend. The balance lookup is a GET, and every figure below is
   arithmetic over scripts/pricing.mjs's table - running doctor creates no image, no clip and no
   Sol call. */

if (!pricing) {
  /* Counted as a problem, unlike everything else in this section. The other scripts degrade to
     "cost not estimated" and still run; what a MISS here says is that the install is incomplete,
     which is the thing preflight is for. */
  problems += bad(`no cost view or balance check - ${pricingProblem}`,
    'pricing.mjs ships next to this file. Re-copy scripts/ from the skill, whole.')
} else {
  /* Never fatal. Somebody who pinned a rate did it because ours is wrong for them, so quietly
     falling back to ours would price their run at a number they had already rejected - which is
     worth a WARN, and is not a reason to call the environment broken. */
  for (const p of rates.problems) note(`rate override ignored - ${p}`, null, 'WARN')

  const bal = await balanceLookup
  /* Priced at the defaults of the three scripts - storyboard.mjs --steps 6, keyframes.mjs
     --resolution 2K, tween.mjs --mode pro --duration 5 - so this is the bill for doing exactly
     what the hint at the bottom of a clean run tells you to do. */
  const run = pricing.estimateRun({ steps: 6, seconds: 5, mode: 'pro', resolution: '2K', rates })
  /* A partial total is a FLOOR, not a total. Comparing a balance against one as though it were
     the bill would understate what the run needs, so anything short of fully priced is not
     compared - the total prints "at least ..." and names what it excluded, which is the honest
     signal when the table cannot price a stage. */
  const priced = run.known && !run.partial ? run : null

  if (!bal.known) {
    /* FAILS SOFT, ALWAYS. An unreachable billing endpoint is not a broken environment: every
       check above can still pass and the pipeline can still run. The only thing missing is a
       number preflight is allowed not to have, and a preflight that goes red over one of those
       teaches people to ignore red. The route row above is where a MOVED endpoint shows up as a
       problem - which is the difference this section relies on that row to draw. */
    note(`balance unavailable - ${bal.reason}`,
      'Not counted against this preflight: the run does not need this number, you do.')
  } else if (bal.credits <= 0) {
    /* A confirmed empty account is the one balance answer that IS a broken environment: the very
       first createTask fails, and it fails after the interview has been sat through. */
    problems += bad(`${pricing.formatBalance(bal)} - a run would fail at its first call`,
      'Top up at kie.ai -> Credits. Nothing in this pipeline is free.')
  } else if (priced && bal.credits < priced.credits.high) {
    /* Against the HIGH end, because the high end is what running out mid-run is measured against.
       formatBalance says how far short; it is the one thing allowed to render that comparison. */
    note(pricing.formatBalance(bal, priced),
      'Top up, or order less: fewer --steps, a shorter --duration, or --mode std.', 'WARN')
  } else {
    ok(pricing.formatBalance(bal, priced))
  }

  /* "checked: 2026-08-07" tells a reader in 2027 nothing unless they do the subtraction, so do it
     here. The dates exist because this repo has already shipped a reference doc that claimed to
     be verified over contracts that were wrong; a table nobody re-reads is the same trap wearing
     a date. Only built-in rows carry one - a pinned rate reads "this run" and cannot go stale. */
  const STALE_DAYS = 120
  const dated = Object.values(rates.entries).map(e => Date.parse(e.checked)).filter(Number.isFinite)
  const asOf = dated.length ? new Date(Math.min(...dated)) : null
  const checkedOn = asOf ? asOf.toISOString().slice(0, 10) : ''
  /* Clamped, because a machine whose clock sits behind the check date should print "today" rather
     than a negative age - this is a staleness hint, not a measurement worth defending. */
  const ageDays = asOf ? Math.max(0, Math.floor((Date.now() - asOf.getTime()) / 86400000)) : null
  const howLong = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`
  if (!asOf) {
    note('every rate is pinned by you, so there is no built-in figure here to go stale')
  } else if (ageDays > STALE_DAYS) {
    note(`the built-in rates were last read from kie.ai on ${checkedOn} - ${howLong}`,
      'Vendor prices move. Re-read the pages named below and update scripts/pricing.mjs,\n' +
      '        or pin your own with SSH_RATES.', 'WARN')
  } else {
    ok(`rate table last read from kie.ai's own pages on ${checkedOn} (${howLong})`)
  }

  console.log('\n  what a default run costs, before you order any of it:\n')
  for (const l of pricing.formatBreakdown(run)) console.log('    ' + l)
  console.log('\n  every rate behind those figures, and the page each was read from:\n')
  for (const l of pricing.formatRates(rates)) console.log('    ' + l)
  if (rates.overrides.length) console.log(`\n    pinned by you: ${rates.overrides.join(', ')}`)
  console.log('\n    Pin your own rates without editing the table:')
  console.log('      SSH_RATES=\'{"video":{"pro":16},"image":{"2K":8}}\'    (PowerShell: $env:SSH_RATES=\'...\')')
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
