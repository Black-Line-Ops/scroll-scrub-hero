/* Entry point for the whole suite:  node test/run.mjs  (or  npm test  ).

   Deliberately not `node --test`. Importing the suites into one process needs no flag, so it runs
   the same way on every Node this skill supports, and it keeps the promise the rest of the repo
   makes: a bare `node <file>` with nothing installed. node:test collects whatever the imports
   register, runs it, and sets a non-zero exit code if anything fails.

   Nothing in here reaches the network, and nothing in here can spend money - see the header of
   test/helpers/harness.mjs for how that is enforced rather than merely intended. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ffmpegStatus } from './helpers/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = fs.readdirSync(here).filter(f => f.endsWith('.test.mjs')).sort()

if (!suites.length) {
  console.error(`no *.test.mjs files in ${here}`)
  process.exit(1)
}

/* A skipped test and a passing test are indistinguishable from the exit code, and several of the
   frame tests skip themselves when ffmpeg is unusable. A mutation run measured what that costs:
   with ffmpeg off PATH, deleting build-frames.mjs's stale-config removal OR its trailing-frame pop
   leaves the suite exiting 0 at 164 pass / 11 skipped. Both fixes go unverified and nothing says so.

   So say so, loudly, before the run - and let CI and a pre-release check demand the real thing with
   SSH_REQUIRE_FFMPEG=1 rather than trusting a green tick that skipped the ffmpeg paths. */
const ff = ffmpegStatus()
if (!ff.ok) {
  const msg = [
    '',
    '  ####  ffmpeg is not usable here: ' + ff.why,
    '  ####  The frame tests will SKIP, not fail. A green suite below does NOT cover:',
    '  ####    - build-frames removing a stale config.js before it rebuilds (residual 3)',
    '  ####    - the trailing frame being dropped from the END of each clip (the seam fix)',
    '  ####    - the sb.motions gap check and the sb.steps guard',
    '  ####  Run with a real ffmpeg before trusting this, or set SSH_REQUIRE_FFMPEG=1 to make',
    '  ####  the absence an error instead of a footnote.',
    '',
  ].join('\n')
  if (process.env.SSH_REQUIRE_FFMPEG === '1') {
    console.error(msg + '  SSH_REQUIRE_FFMPEG=1 is set, so this is a failure.\n')
    process.exit(1)
  }
  console.error(msg)
}

/* Sequential, not Promise.all: several suites spawn child processes that shell out to ffmpeg, and
   interleaving those makes a failure report unreadable for no wall-clock worth having. */
for (const file of suites) {
  await import(pathToFileURL(path.join(here, file)).href)
}
