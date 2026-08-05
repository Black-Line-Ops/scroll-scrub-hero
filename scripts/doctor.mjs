/* Preflight. Run this first, and whenever something is behaving oddly.
   Everything this checks is a thing that otherwise fails deep inside a run, often after
   money has been spent - so it is worth the ten seconds. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ok = (m) => console.log(`  OK    ${m}`)
const bad = (m, fix) => { console.log(`  MISS  ${m}`); if (fix) console.log(`        ${fix}`); return 1 }
let problems = 0

console.log('\nscroll-scrub-hero preflight\n')

/* --- node --- */
const major = parseInt(process.versions.node.split('.')[0], 10)
if (major >= 18) ok(`Node ${process.versions.node}`)
else problems += bad(`Node ${process.versions.node} is too old (need 18+ for built-in fetch)`,
  'Install a current Node from nodejs.org, then reopen your terminal.')

/* --- ffmpeg + ffprobe --- */
for (const bin of ['ffmpeg', 'ffprobe']) {
  try {
    const v = execFileSync(bin, ['-version'], { encoding: 'utf8' }).split('\n')[0]
    ok(v.slice(0, 60))
  } catch (_) {
    problems += bad(`${bin} not found on PATH`,
      os.platform() === 'win32'
        ? 'winget install Gyan.FFmpeg     (then reopen your terminal)'
        : os.platform() === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install ffmpeg')
  }
}

/* --- the API key --- */
if (process.env.KIE_API_KEY) {
  const k = process.env.KIE_API_KEY
  ok(`KIE_API_KEY is set (${k.slice(0, 4)}…${k.slice(-4)}, ${k.length} chars)`)
} else {
  problems += bad('KIE_API_KEY is not set', 'See "Setting your key" below.')
}

/* --- is the key actually good? only worth asking if one is present --- */
if (process.env.KIE_API_KEY) {
  try {
    const res = await fetch('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=preflight-probe', {
      headers: { Authorization: `Bearer ${process.env.KIE_API_KEY}` },
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
process.exit(problems ? 1 : 0)
