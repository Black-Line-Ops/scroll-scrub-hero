/* Set up KIE_API_KEY, safely, in one command.

   This exists because "set an environment variable" is the step that loses people. It is the only
   part of this pipeline that has nothing to do with the thing they came here to build, and every
   platform does it differently, so the instructions are a wall of shell snippets in which the
   reader has to correctly identify their own situation before they can start.

   Worse, the failure is silent and delayed: a key with a trailing space, or set in one terminal
   and read from another, or set with `set` instead of `setx`, all look exactly like a key that
   simply does not work - and the error arrives from kie.ai as an HTTP 200 containing {"code":401},
   which reads as a server problem rather than a typing one.

   So: prompt for it, strip what people accidentally paste around it, TEST it against kie.ai
   before saving anything, and only then write it where a future terminal will find it.

   THE KEY IS NEVER PRINTED, never written to any file inside this repo, and never passed on a
   command line - not even to the PowerShell call that persists it, because command lines are
   visible to other processes. It goes through an environment variable on the child instead. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const KEY = 'KIE_API_KEY'
const SIGNUP = 'https://kie.ai?ref=da271de69b92c3461d59a15884817078'

const say = (s = '') => console.log(s)
const win = os.platform() === 'win32'

/* ---------- reading the key without putting it on screen ----------
   Raw mode, one keypress at a time, echoing nothing. A pasted key is delivered as a burst of
   characters rather than one at a time, which this handles because it appends whatever arrives.
   Backspace is supported because people do retype these. */
function promptHidden (question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('not a terminal'))
      return
    }
    process.stdout.write(question)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    let buf = ''
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '') {                                   /* ctrl-c */
          process.stdin.setRawMode(false)
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '' || ch === '\b') { buf = buf.slice(0, -1); continue }
        if (ch < ' ') continue                                   /* ignore other control chars */
        buf += ch
      }
    }
    process.stdin.on('data', onData)
  })
}

/* ---------- what people actually paste ----------
   In rough order of how often it happens: a trailing newline, surrounding quotes because they
   copied from a code block, a leading "KIE_API_KEY=" because they copied the whole example line,
   and a non-breaking space from a web page. Every one of these produces a key that looks right in
   a terminal and is rejected by the API. */
export function clean (raw) {
  let s = String(raw).replace(/ /g, ' ').trim()
  s = s.replace(/^\$?env:/i, '')                    /* PowerShell: $env:KIE_API_KEY = "..." */
  s = s.replace(/^(export|set|setx)\s+/i, '')       /* copied the whole example line */
  /* `=` OR whitespace: `setx KIE_API_KEY "value"` separates with a space, not an equals, and that
     is the one Windows tells people to use. Only stripped when the NAME leads, so a key that
     merely contains a space is left intact for the caller to refuse. */
  s = s.replace(/^KIE_API_KEY\s*=\s*|^KIE_API_KEY\s+/i, '')
  s = s.replace(/^(["'])([\s\S]*)\1$/, '$2')        /* quotes from a code block */
  return s.trim()
}

/* ---------- does kie.ai accept it? ----------
   The same probe doctor.mjs uses, and for the same reason: kie.ai reports auth failures INSIDE an
   HTTP 200 as {"code":401}, so checking res.status alone would call a dead key good. */
export async function check (key) {
  try {
    const res = await fetch('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=connect-key-probe', {
      headers: { Authorization: `Bearer ${key}` },
    })
    let body = {}
    try { body = await res.json() } catch (_) {}
    const code = body && body.code !== undefined ? String(body.code) : null
    if (res.status === 401 || code === '401' || code === '403') {
      return { ok: false, why: `kie.ai rejected it${body.msg ? ` — ${body.msg}` : ''}` }
    }
    if (code && !['200', '404', '422'].includes(code)) {
      return { ok: false, why: `kie.ai answered code ${code}${body.msg ? ` — ${body.msg}` : ''}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, why: `could not reach kie.ai (${e.message})`, offline: true }
  }
}

/* ---------- persist it ---------- */
function persistWindows (key) {
  /* Through the child's ENVIRONMENT, never its argv: a command line is readable by any other
     process on the machine while it runs, and this one would contain the key. */
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('${KEY}', $env:__CONNECT_KEY_VALUE, 'User')`],
    { env: { ...process.env, __CONNECT_KEY_VALUE: key }, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) {
    return { ok: false, why: (r.stderr || '').toString().trim() || `powershell exited ${r.status}` }
  }
  return { ok: true, where: 'your Windows user environment' }
}

function persistUnix (key) {
  const shell = process.env.SHELL || ''
  const rc = /zsh/.test(shell) ? '.zshrc' : /bash/.test(shell) ? '.bashrc' : '.profile'
  const file = path.join(os.homedir(), rc)
  const line = `export ${KEY}="${key}"`
  let existing = ''
  try { existing = fs.readFileSync(file, 'utf8') } catch (_) {}
  /* Replace an existing line rather than stacking a second one - two exports means the last one
     wins and the first is a confusing red herring next time someone reads the file. */
  const re = new RegExp(`^export ${KEY}=.*$`, 'm')
  const next = re.test(existing)
    ? existing.replace(re, line)
    : (existing + (existing.endsWith('\n') || !existing ? '' : '\n') + line + '\n')
  try {
    fs.writeFileSync(file, next, { mode: 0o600 })
    return { ok: true, where: `~/${rc}`, replaced: re.test(existing) }
  } catch (e) {
    return { ok: false, why: e.message }
  }
}

/* ---------- go ----------
   Wrapped so that clean() and check() can be imported and tested. A skill whose scripts are all
   top-level programs cannot unit-test any of them; this one function is worth the exception,
   because what it does is guess what a stranger pasted. */
const RUN_DIRECTLY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (RUN_DIRECTLY) await main()

async function main () {
say()
say('Connect your kie.ai API key')
say('───────────────────────────')
say()

if (!process.stdin.isTTY) {
  console.error('This needs a real terminal, because it asks you to type your key without showing it.')
  console.error('')
  console.error('You are seeing this because it was run by a script, a pipe, or an AI agent.')
  console.error('Open PowerShell (Windows) or Terminal (macOS) yourself and run:')
  console.error('')
  console.error(`  node "${process.argv[1]}"`)
  console.error('')
  process.exit(1)
}

const already = process.env[KEY]
if (already) {
  const c = await check(already)
  if (c.ok) {
    say(`You already have a working key set (${already.length} chars, starts ${already.slice(0, 3)}…).`)
    say('Press Enter to keep it, or paste a new one to replace it.')
    say()
  } else {
    say(`A key is set but ${c.why}.`)
    say('Paste the new one below.')
    say()
  }
}

say(`Get a key at:  ${SIGNUP}  →  API keys`)
say('  (that is a Black Line Ops affiliate link — it costs you nothing extra)')
say('  Your account needs credits on it; a first run is about $2.')
say()
say('Paste it and press Enter. Nothing will appear as you type — that is deliberate.')
say()

let raw
try {
  raw = await promptHidden(`  ${KEY}: `)
} catch (e) {
  console.error(`\nCould not read from the terminal (${e.message}).`)
  process.exit(1)
}

const key = clean(raw)

if (!key) {
  if (already) { say('Nothing entered — keeping the key you already had.'); process.exit(0) }
  console.error('Nothing entered, and no key was set. Run this again when you have one.')
  process.exit(1)
}
if (/\s/.test(key)) {
  console.error('\nThat has a space in it, so it is not a key on its own.')
  console.error('Copy just the key itself — not the whole example line, and not the surrounding quotes.')
  process.exit(1)
}

say()
say('Checking it with kie.ai…')
const verdict = await check(key)

if (!verdict.ok) {
  console.error(`\n  ✗ ${verdict.why}`)
  console.error('')
  if (verdict.offline) {
    console.error('  Nothing was saved. Check your connection and run this again.')
  } else {
    console.error('  Nothing was saved, because saving a key that does not work would just move the')
    console.error('  problem to your next command. Worth checking:')
    console.error('    • the key is still active at kie.ai → API keys')
    console.error('    • you copied the key, not the key ID or the name beside it')
    console.error('    • it was copied whole — these are long, and selection often clips the end')
  }
  process.exit(1)
}

say('  ✓ kie.ai accepted it')
say()

const saved = win ? persistWindows(key) : persistUnix(key)
if (!saved.ok) {
  console.error(`Could not save it (${saved.why}).`)
  console.error('The key is good, so you can still use it in this terminal only:')
  console.error(win ? `  $env:${KEY} = "<your key>"` : `  export ${KEY}="<your key>"`)
  process.exit(1)
}

say(`  ✓ saved to ${saved.where}${saved.replaced ? ' (replacing the previous line)' : ''}`)
say()
say('One thing to know: programs read their environment when they START, so anything that is')
say('already open — this terminal, your editor, Claude Code — will not see it until you')
say('restart it. New terminals get it automatically.')
say()

/* The balance, if pricing.mjs is next door. It is the number that answers the question people
   actually have at this point, which is not "is my key valid" but "can I afford to run this". */
try {
  const pricing = await import('./pricing.mjs')
  const bal = await pricing.fetchBalance({ apiKey: key })
  if (bal.known) {
    say(`Your balance: ${pricing.formatCost({ known: true, credits: { low: bal.credits, high: bal.credits }, usdLow: bal.usd, usdHigh: bal.usd }, { caveat: false })}`)
    say('A default 5-scene run is about $2.05.')
  }
} catch (_) { /* optional, and never worth failing the setup over */ }

say()
say('Now check everything else:')
say(`  node "${path.join(path.dirname(process.argv[1]), 'doctor.mjs')}"`)
say()
}
