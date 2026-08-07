# test/

```
npm test
node test/run.mjs      # identical - the npm script is just a shortcut
```

No install step, no dependencies, no flags. `node:test` and `node:assert` are builtins, the same
way every script in `scripts/` is builtin-only. If `node scripts/doctor.mjs` runs on a machine,
so does this.

**Nothing here touches the network and nothing here can spend money.** That is enforced, not
merely intended — see [How the money is kept out](#how-the-money-is-kept-out).

---

## Why this exists

A regression in this skill is **billable**. Every defect the August 2026 audit turned up had the
same shape: it was invisible until a run had already been paid for, and several of them exited 0
while shipping a broken deliverable.

- an argument parser bug paid kie.ai to storyboard the literal string `Idea: true`
- an unquoted `--idea bare yard to pool` paid to storyboard the single word `bare`
- `--budget-mb` with no value became `NaN`, and `mb > NaN` is false for every `mb`, so the
  page-weight guard printed PASS while switched off
- a missing segment slid every later caption one chapter out of place, and the run exited 0
- a truncated clip was padded from 16 frames to 40 by repeating the last one 25 times — a chapter
  frozen for 62% of its scroll, reported as a clean 40, exit 0
- a storyboard that parsed but was structurally wrong threw a stack trace *before* the paid Sol
  response was written to disk, destroying it
- a create whose socket dropped after the server had already taken it was retried four more times,
  billing five renders for one call and printing nothing but `retrying in 2s`

None of those are subtle once someone looks. There was simply no cheap way to look. That is the
whole job of this directory: make the expensive failures catchable for free.

## Why there are no network tests

Because every interesting call to kie.ai costs money, and a test suite that costs money is a test
suite nobody runs.

There is a second reason, and it matters more: a paid test would be **slow and non-deterministic**
in exactly the places these tests need to be fast and exact. Sol's output varies run to run. The
tests below assert on the schema validator's behaviour when Sol returns something malformed —
which is not a thing you can reliably ask a live model to do.

The only calls made against kie.ai from anywhere in this repo are the *unauthenticated* route
probes in `scripts/doctor.mjs`, which are free (a route that exists answers 401, one that has
moved answers 404). They are not exercised here; `doctor.mjs` is a top-level program that probes
on load, so importing it would make the suite hit the network.

## What is covered

| File | Guards |
|---|---|
| `args.test.mjs` | the shared argument parser: both flag forms, flag-shaped values, value-less numeric flags, `--only`, `--var`, unquoted multi-word values, `--yes=false` |
| `contact-sheet.test.mjs` | HTML escaping of hostile storyboard text and `--ref2` filenames in the approval sheet, all six sinks, the `<title>` RCDATA case, the CSP |
| `build-frames-gaps.test.mjs` | a storyboard motion with no video stops the build; `--allow-gaps` permits it deliberately and keeps chapter numbering honest |
| `frame-normalisation.test.mjs` | the trailing-frame drop is preserved and drops from the *end*; a badly under-length clip is refused rather than padded; a small shortfall still pads |
| `storyboard-schema.test.mjs` | malformed Sol output is refused, every complaint at once, and the paid raw response reaches disk first |
| `kie-client.test.mjs` | `sniffMime` through `uploadFile`: mime and extension always agree, the extension on disk is not evidence, unknown files are refused before any request, and the upload host |
| `retry-policy.test.mjs` | **which calls may be replayed and which may not** — see below, the names do not tell you why |
| `doctor-mask.test.mjs` | the `KIE_API_KEY` mask never prints a short key in full |
| `encoder-column.test.mjs` | the libwebp check matches the encoder-**name** column, in `doctor.mjs` and in `ffmpegStatus()`, so `libwebp_anim` alone is not mistaken for a usable build |
| `only-unknown-id.test.mjs` | `--only` with an unknown id stops rather than reporting the run finished — in `keyframes.mjs` *and* `tween.mjs`, in the same shape |
| `stale-config.test.mjs` | a run that dies mid-loop takes the **previous** run's `config.js` with it, so no config ever describes frames that are not on disk |
| `build-frames-steps.test.mjs` | a storyboard with motions but no steps is refused above the clip loop, before any ffmpeg time is spent |
| `image-url-unwrap.test.mjs` | `image_url` reaches Sol as a URL **string**, not as `uploadFile`'s `{url, uploadedAt}` record — for `--ref` and `--ref2` alike, and no record leaks in by another route |

## Why `retry-policy.test.mjs` is the one to not delete

Its tests read like plumbing — *"exactly ONE POST"*, *"still retries"* — so it is worth writing down
what they are actually standing on, because the names do not say it.

kie.ai **accepts no idempotency key**. A `createTask` that the server had already accepted, retried,
becomes a **second billed render whose taskId we never learn** — an orphan nobody collects, on an
invoice nobody can explain. So `req()` in `scripts/kie.mjs` takes an `idempotent` flag, and
`createTask` is the single caller that passes `false`. That one argument is the whole fix.

It had **no coverage at all** until this file. It worked, and nothing would have noticed if it
stopped: the flag can go on being *passed* while nothing *consults* it, and every test in the suite
would still be green. That is not a hypothetical — it is how the reverted copy used to validate
these tests behaves.

Two properties, and they pull in opposite directions, which is why both are pinned:

- **A create is never replayed.** Asserted as a request **count**, not as "it threw" — a throw
  happens either way, and only the count can see the second charge. Two failure shapes: an
  HTTP 5xx, and a dropped socket. The dropped socket is the likelier one and the nastier one,
  because the request *reached the server*, so the task exists and will be billed, and the client
  cannot tell that from a request that never left. That one is counted **on the server**, by a
  throwaway `http` listener on `127.0.0.1` that takes the whole request body and then kills the
  connection — the client's request is rewritten onto it so a real undici failure is what gets
  handled. The operator also has to be *told*: a create that silently declines to retry looks like
  any other blip, and the next move is re-running the step by hand, which is the bill just avoided.
  So the `recordInfo` warning is asserted too.
- **Everything else still retries.** A 429 on a create (rate-limited means turned away before
  anything was created), every poll, and an upload 5xx. Over-correcting into no-retry-anywhere
  would be its own regression — brittle runs, and a poll that gives up abandons a render already
  paid for — and **nothing else in the suite would catch it**.

These tests were validated the way the rest of this suite should be: the `idempotent` guards were
deleted from a **scratch copy** of `kie.mjs` and the file was re-run. The three create tests went
red — `5 !== 1` server-side creates, five billed renders from one call — and the four
retry-must-survive tests stayed green. A test that passes against the buggy code is worthless.

One caveat, recorded so nobody over-reads the file: the *mid-response* drop test holds with or
without the flag. `fetch()` resolves once headers arrive and it is `await res.text()` that rejects,
which is outside the attempt loop, so that failure escapes as a bare `TypeError('terminated')` and
is never retried by any mechanism. It still pins the count; it just is not evidence about the flag.

## The four files that were written last, and why each one is shaped oddly

Mutation testing found three shipped fixes with **no test that could fail if they were reverted**.
The suite was green at 151/151 with all three deleted. A fix whose test cannot fail is not a fix —
it is a comment claiming one, which is the sharpest thing the audit said about this repo.

Each of these files is built around the one input that separates the fix from the bug. That input
is usually not the obvious one, so it is written down here as well as in each file's header:

- **`encoder-column.test.mjs`** — the discriminating fixture is a listing holding **only** the
  `libwebp_anim` row, in the real column format. Real ffmpeg prints *two* rows and **both** carry
  the standalone token `libwebp` in their *description* column, so `/\blibwebp\b/` — the regex
  that shipped — returns true on a build that cannot encode a still WebP. A listing with *neither*
  row is refused by the old regex too, so a test built only from that one is green against the bug.
  The file asserts that the old regex **does** match the anim-only fixture, so nobody can quietly
  edit the fixture into something that proves nothing.
  `ffmpegStatus()` is covered for a reason easy to miss: a broken regex there returns `{ok:false}`,
  which **skips** every ffmpeg-backed frame test rather than failing one. The suite stays green and
  stops checking `build-frames.mjs`. "The suite is green" is not evidence about that function.
- **`only-unknown-id.test.mjs`** — the original defect was a **divergence**: `tween.mjs` refused an
  unknown `--only` id and `keyframes.mjs` did not. So parity between the two is pinned as its own
  assertion. Fixing one script with a different exit code, stream or message shape would close this
  instance and leave the class open.
- **`stale-config.test.mjs`** — there are already two `config.js does not exist` assertions in
  `frame-normalisation.test.mjs`, and **they do not cover this fix**. Both run on a fresh staged
  tree where no config was ever written, so they are true before the script starts. Verified: with
  the removal deleted, both stay green. The test has to write a config **first**, then fail the run
  mid-loop, then look. That ordering is the whole test.
- **`build-frames-steps.test.mjs`** — `steps: []` is asserted as a **refusal**, not as "does not
  crash". `[].find(...)` returns `undefined` rather than throwing, `|| {}` swallows it, and the
  build runs to completion at exit 0 with every chapter captioned `Step 1`, `Step 2` — a paid
  deliverable with placeholder labels. A test that only looked for the `TypeError` would pass.

All four were validated the way `retry-policy.test.mjs` was: the fix was reverted in a **scratch
copy** and the file re-run. Reverting `doctor.mjs`'s regex fails 2, the harness copy fails 2,
deleting the `--only` guard fails 5, deleting the `config.js` removal fails 2 (while
`frame-normalisation.test.mjs` stays green — that is the point), and deleting the `sb.steps` guard
fails 2, one of them with the exact `Cannot read properties of undefined (reading 'find')` the
guard replaced.

## How the money is kept out

Three mechanisms, in `test/helpers/harness.mjs`.

**1. Staged copies with a stub client.** Every file in `scripts/` is a top-level *program*, not a
module — importing `keyframes.mjs` runs it. So `stageScript()` copies the script under test, byte
for byte out of `scripts/` at test time, into a temp directory next to a **generated** `kie.mjs`.
The copy's `import ... from './kie.mjs'` resolves to the stub. The stub re-exports the genuinely
pure helpers (`args`, `state`, `confirm`) from the real module — so the parser and the state
loader under test are the *real* ones — and replaces `createTask`, `pollTask`, `download` and
`sol` with functions that throw the word `BILLABLE`.

Copying rather than importing is a deliberate trade: the logic under test is always the shipped
logic, because the copy is made from `scripts/` on every run and can never drift.

**2. `runScript()` fails on `BILLABLE`.** A test that wanders onto a paid code path does not pass
quietly; it throws with the child's whole output attached.

**3. The child gets no credential.** `runScript()` deletes `KIE_API_KEY` from the child's
environment. If a test somehow reached the real client despite the stub, there is nothing in
scope for it to spend with.

`kie-client.test.mjs` is the one suite that imports `scripts/kie.mjs` directly, because
`uploadFile` is a real export. It replaces `globalThis.fetch` with a recorder that answers every
request itself and asserts the URL, so nothing leaves the process there either.

## The ffmpeg-dependent tests

`frame-normalisation.test.mjs` and two tests in `build-frames-gaps.test.mjs` drive **real ffmpeg**,
because the thing under test is how `build-frames.mjs` reacts to the number of files ffmpeg
actually wrote. A mocked encoder would only test the mock.

ffmpeg is a hard requirement of the skill, so this is not an optional dependency — but a
contributor without it (or with a build lacking `libwebp`) gets a **named skip**, not a red suite.

### The skip is not free, so it announces itself

A skipped test and a passing test look identical from the exit code, and that gap was measured
rather than assumed: with ffmpeg off `PATH`, **deleting** `build-frames.mjs`'s stale-config removal
*or* its trailing-frame pop still leaves the suite exiting 0 at 167 pass / 11 skipped. Both fixes go
unverified and nothing about a green tick says so.

So `run.mjs` prints a loud banner before the run naming exactly what is not covered, and:

```bash
SSH_REQUIRE_FFMPEG=1 node test/run.mjs
```

turns a missing ffmpeg into a **failure** instead of a footnote. Use that in CI and before any
release — a green suite that skipped the ffmpeg paths is not evidence about them.

Frame counts are steered with a raw H.264 elementary stream rather than an mp4: ffprobe reports no
container duration for one, so `build-frames.mjs` falls back to the duration recorded in the
segment state — which the test controls. Lying about the duration is precisely what a truncated
download does, so these are the real failures rather than approximations of them.

## Adding a fixture-replay test

This scaffolding exists to enable one thing that is not here yet: **record kie.ai's responses once,
replay them offline forever**. It is the honest answer to "verified August 2026" — a verification
date should be produced by CI, not typed.

The seam is already cut. `stageScript()`'s second argument is the fixture:

```js
const dir = stageScript('storyboard.mjs', { solText: fs.readFileSync('fixtures/sol-pool-6step.json', 'utf8') })
```

To extend it to the stages that are still stubbed out:

1. **Record once, by hand, on a real run.** Add a temporary line to `scripts/kie.mjs`'s `req()`
   that writes `{url, status, body}` to `test/fixtures/<name>.json` whenever
   `process.env.SSH_RECORD_FIXTURES` is set. Do one full pipeline run with a real key. Delete the
   line. This costs one run's credits, once, ever.
2. **Scrub the recording before it is committed.** Every fixture must be checked in by eye:
   strip the `Authorization` header, the account id and every signed URL query string. A fixture
   is a file that gets read by strangers; treat it as public the moment it lands.
3. **Teach the stub to replay.** Give `stubSource()` a `fixtures` option — a map from
   `model` → recorded `resultUrls`, and from `taskId` → the `recordInfo` poll sequence. Have
   `createTask` return a deterministic id and `pollTask` walk the recorded states instead of
   throwing.
4. **Serve the downloads locally.** `download()` currently throws. Point it at a file in
   `test/fixtures/media/` instead — a few real 40-frame clips at 64×36 are a handful of kilobytes
   and make a full `tween.mjs → build-frames.mjs` pass runnable offline.

Keep the throw-on-`BILLABLE` behaviour for anything a fixture does *not* cover. A stub that
silently invents a plausible answer for an uncovered call is worse than one that stops.

## Things that would make this simpler

Two tests reach for a function that is not exported, and say so in their own header comments:

- `esc()` and the `KNOWN_EXT` whitelist in `scripts/keyframes.mjs` are reached by spawning the
  whole script in its all-cached mode. Exporting `esc` would let the escaping test call it
  directly and cover it in microseconds.
- `mask()` in `scripts/doctor.mjs` cannot be imported at all — `doctor.mjs` fires four network
  probes on load. `doctor-mask.test.mjs` lifts the real `const mask = ...` line out of the source
  and evaluates it, and fails asking to be re-pointed if the declaration ever changes shape.
  Exporting `mask` would replace that with a plain import.

Neither is urgent. Both are noted so the next person does not think the workaround was the plan.

## House rules for anything added here

- Node builtins only. No dependency, no build step, no flags — `node test/run.mjs` on a bare
  machine.
- Zero network, zero spend. If a new test needs a response, it needs a fixture.
- Assert the *output* of a subsystem, not the presence of its parts. Several audit findings passed
  a "the element exists" check while producing nothing.
- Every new test file is picked up automatically: `run.mjs` imports every `*.test.mjs` in this
  directory, sorted.
