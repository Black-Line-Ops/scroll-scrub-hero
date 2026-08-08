# kie.ai API contract

Read this when a script errors, when you need a model the scripts don't wrap, or when you're
tempted to call the API by hand.

**What has actually been verified, and when.** On **2026-08-07** every route named below was
probed with no key at all — free, and safe, because an unauthenticated POST creates nothing. A
route that exists answers `401` (as a body `code` inside an HTTP 200 on `api.kie.ai`, as the same
code on the file host); a route that does not exist answers HTTP `404`. That distinguishes
"endpoint moved" from "credentials wrong", and it is the check `scripts/doctor.mjs` now runs at
preflight. It found exactly one wrong contract in this document — the upload host — corrected
below.

The request and response **shapes** here were not re-run against a live keyed call on that date,
because doing so costs the reader's credits. They come from kie.ai's own documentation plus what
the scripts in this skill send and parse successfully. So: routes checked, field-level detail as
good as the vendor docs get — and where those docs contradict themselves, this file says so
rather than picking a side silently. A verification date is a stronger claim than no date, so it
is worth being exact about which half of the contract it covers.

The same rule governs [What it costs](#what-it-costs): every rate there names the page it was
read from and carries a confidence, and the one figure that is *derived* rather than quoted says
so on its own row.

## Contents
- [Auth and base](#auth-and-base)
- [The three-call pattern](#the-three-call-pattern)
- [File upload](#file-upload)
- [Models used by this skill](#models-used-by-this-skill)
- [What it costs](#what-it-costs)
- [Overriding the rates](#overriding-the-rates)
- [Calibration: how the table corrects itself](#calibration-how-the-table-corrects-itself)
- [Credit balance](#credit-balance)
- [Gotchas that cost real time](#gotchas-that-cost-real-time)

## Auth and base

There are **two hosts**, not one. Everything in this document is on `https://api.kie.ai` **except
file upload**, which is on `https://kieai.redpandaai.co` — see [File upload](#file-upload). They
are separate services that happen to take the same bearer token, and treating them as one host is
the mistake this skill actually shipped.

Every request to either carries:

```
Authorization: Bearer $KIE_API_KEY
Content-Type: application/json
```

Send `Accept: application/json` too. The scripts do, because at least one endpoint's default
response format is ambiguous in kie.ai's own docs — see [`stream`](#gpt-56-sol--storyboard-authoring).

A missing or wrong key returns 401. The key lives in the environment only — never commit it,
and never write it into a config file inside a client repo.

## The three-call pattern

Everything in the Market catalogue (Kling, GPT Image, and most others) follows the same shape:

**1. Create** — `POST /api/v1/jobs/createTask`

```json
{ "model": "<model string>", "input": { ... }, "callBackUrl": "https://optional" }
```

Returns `{"code":200,"msg":"success","data":{"taskId":"task_..."}}`.

A 200 here means *accepted*, not *finished*. This is the single most common misreading of this
API.

There is **no idempotency key** on this endpoint, and no client reference field in the body, so
kie.ai cannot de-duplicate a repeated create for you. A create that fails after the server
already accepted the job cannot be safely retried: `kie.mjs` therefore does not retry creates on
a 5xx or a dropped socket, and tells you to query `recordInfo` before making a replacement. It
does still retry a 429, because rate-limited means nothing was created.

**2. Poll** — `GET /api/v1/jobs/recordInfo?taskId=<id>`

```json
{ "code": 200, "data": {
    "taskId": "...", "state": "success", "progress": 100,
    "resultJson": "{\"resultUrls\":[\"https://...\"]}",
    "failCode": "", "failMsg": "", "costTime": 15000, "creditsConsumed": 50 } }
```

`state` is one of `waiting`, `queuing`, `generating`, `success`, `fail`.

**3. Download** the URLs. Do it during the run — hosted results are not permanent storage.

Rate limit: 20 new tasks per 10 s per account, 429 on breach. `kie.mjs` paces creates ~700 ms
apart and backs off exponentially, which keeps well clear.

## File upload

Kling and GPT Image accept image **URLs** only — not local paths, not base64 inline. To use a
local photo, upload it first:

`POST https://kieai.redpandaai.co/api/file-base64-upload`

**This is the one route that is not on `api.kie.ai`, and the full URL above is not a typo.**
Probed unauthenticated on 2026-08-07:

```
POST https://api.kie.ai/api/v1/file-base64-upload       -> HTTP 404 Not Found
POST https://api.kie.ai/api/file-base64-upload          -> HTTP 404 Not Found   (dropping /v1 is NOT the fix)
POST https://kieai.redpandaai.co/api/file-base64-upload -> HTTP 200, body code 401 (route exists, auth required)
```

The jobs API and the file host are two different services. Point uploads back at `api.kie.ai` —
which is the natural "correction" for anyone who reads the host as a mistake — and every run in
this skill dies at its first network call with `HTTP 404 - No message available`, an error that
does not name the URL it called. `scripts/kie.mjs` keeps this host in its own `UPLOAD_BASE`
constant, next to the same three probe lines, for that reason.

The body:

```json
{ "base64Data": "data:image/png;base64,...", "uploadPath": "images", "fileName": "ref.png" }
```

The upload host also answers in a slightly different envelope from the jobs API — it adds a
`success` boolean alongside the familiar `code`/`msg`.

**Which field carries the URL is not settled.** kie.ai's quickstart shows `fileUrl` under `data`;
its OpenAPI page for the same endpoint lists `data` as
`fileName`/`filePath`/`downloadUrl`/`fileSize`/`mimeType`/`uploadedAt`, with no `fileUrl` at all.
Read whichever is present rather than betting on one — `kie.mjs` accepts `data.fileUrl`,
`data.url`, `data.downloadUrl` and a top-level `fileUrl`.

**Uploads are deleted after 24 hours**, which is fine inside a run but means you cannot treat
these URLs as durable. If you resume a run days later, re-upload.

Two client-side limits worth knowing, both enforced by `kie.mjs` before anything is sent. The
body is base64, so a 10 MB photo becomes ~13 MB of JSON held in memory and posted in one request
— it refuses anything larger and names an ffmpeg downscale command. And the `data:` mime is taken
from the file's own magic bytes rather than its extension, so JPEG, PNG and WebP go through and
anything else (a HEIC straight off an iPhone is the common one) is rejected by name instead of
being uploaded mislabelled.

## Models used by this skill

### GPT 5.6 Sol — storyboard authoring

Not a `createTask` model. It is a Responses-style endpoint that answers inline:

`POST /codex/v1/responses`

```json
{ "model": "gpt-5-6-sol",
  "input": [ { "role": "user", "content": [
      { "type": "input_text",  "text": "..." },
      { "type": "input_image", "image_url": "https://..." } ] } ],
  "stream": false,
  "reasoning": { "effort": "medium" } }
```

Effort is `low` (default), `medium`, `high`, `xhigh`. Text comes back at
`output[].content[].text` where `type === "output_text"`.

`image_url` is a **bare URL string**, not an object. Passing `{url, uploadedAt}` — the shape an
upload helper naturally returns — produces an HTTP 500, which reads like vendor flakiness and is
not.

**Send `stream` explicitly.** kie.ai's own documentation contradicts itself on the default: the
schema declares `stream` with `default: false` while the prose beside it says "Default is true."
Omit the field and you are betting on which one the server implements; a wrong bet returns
`text/event-stream`, which a client expecting JSON cannot parse. The scripts send
`stream: false` and an `Accept: application/json` header so the answer stops mattering. If you
call this endpoint by hand and get a stream anyway, read the content-type before blaming the
model — kie.mjs now names it (`expected a JSON response, got text/event-stream`) instead of
reporting an empty result.

It is a chat/reasoning model — it **cannot generate images**. Its value here is that it is
multimodal, so it can look at the reference photo and write steps grounded in what's actually
there.

### GPT Image 2 — keyframe stills

`model: "gpt-image-2-image-to-image"`

```json
{ "prompt": "up to 20000 chars",
  "input_urls": ["https://...", "https://..."],
  "aspect_ratio": "16:9",
  "resolution": "2K" }
```

Up to 16 input images. Aspect ratios include `auto`, `1:1`, `4:3`, `3:2`, `16:9`, `21:9` and
their inverses. Resolution is `1K`, `2K`, `4K` — with caveats: `auto` and the `5:4`/`4:5` ratios
only support 1K, and 1:1 cannot go 4K. For a 16:9 hero, `2K` is the sweet spot: sharper than the
frames need, so downscaling hides any softness.

### Kling 3.0 — first/last-frame video

`model: "kling-3.0/video"`

```json
{ "prompt": "max 500 chars in single-shot mode",
  "image_urls": ["<first frame>", "<last frame>"],
  "duration": "5",
  "aspect_ratio": "16:9",
  "mode": "pro",
  "sound": false,
  "multi_shots": false }
```

- **`duration` is a STRING, not a number.** The schema declares it as an enum of `"3"`…`"15"`
  and the official example sends `"5"`. Passing the integer `5` fails validation with a 422 —
  which is an easy bug to ship, because everything else in the payload is naturally typed.
- **Send `multi_shots: false` explicitly.** The spec lists it among the required input fields
  even for a single-shot render.
- `mode` is `std` (1280×720), `pro` (1920×1080) or `4K` (3840×2160) at 16:9.
- `image_urls` order is **[first, last]**. With images supplied, `aspect_ratio` becomes
  advisory — the model adapts to the images.
- The prompt cap is 500 characters in single-shot mode. Longer prompts are rejected, so trim.
- `multi_shots` + `multi_prompt` exist for multi-shot sequences, but a scrub hero wants the
  opposite of shot changes, so leave them off.
- `kling_elements` can pin named subjects across a video. Not needed when both endpoints are
  fixed images, which already constrain the result far more tightly.

The documentation states plainly that first and last frames should be **as similar as possible**,
because large differences cause a lens switch. That single sentence is the design constraint the
whole skill is built around.

## What it costs

This section is the documentation of `scripts/pricing.mjs`. That file is the single source of
every cost figure the scripts print; if this document and that table ever disagree, **the table
is right and this is stale** — run `node scripts/pricing.mjs` to see the live one with its
provenance, or `node scripts/doctor.mjs` to see it next to your actual balance.

### The conversion

**1 credit = $0.005 USD.** Read from https://kie.ai/pricing, which states it twice in its own
copy ("Each credit is valued at $0.005 USD", "Exchange: 1 cr = $0.005"). Corroborated two more
ways: the account holder's own $5 = 1000 credits top-up, and the fact that every per-model quote
on the site carries credits and dollars side by side at exactly this ratio. This is the one row
everything else leans on, which is why it is the one row with three independent agreements.

One nuance that makes the dollars *conservative* rather than wrong: kie.ai advertises 5% or 10%
bonus credits on some top-up SKUs, so an effective price can be up to ~10% below $0.005. Credits
consumed are exact either way. If you are on a bonus SKU, pin `creditUsd` — see
[Overriding the rates](#overriding-the-rates).

### The rates

Read on **2026-08-07** from kie.ai's own public pages, unauthenticated — free and safe, because
a GET of a marketing page creates nothing. Each row names the page, so the check is re-runnable
rather than something you have to take on trust.

| Key | Rate | Per | Confidence | Read from |
|---|---|---|---|---|
| `creditUsd` | $0.005 | credit | **high** | https://kie.ai/pricing — "Each credit is valued at $0.005 USD" |
| `image.1K` | 6 cr ($0.03) | image | **high** | https://kie.ai/gpt-image-2 — "6 credits ($0.03) for 1 K" |
| `image.2K` | 10 cr ($0.05) | image | **high** | https://kie.ai/gpt-image-2 — "10 credits ($0.05) for 2 K" |
| `image.4K` | 16 cr ($0.08) | image | **high** | https://kie.ai/gpt-image-2 — "16 credits ($0.08) for 4 K" |
| `video.std` | 14 cr ($0.07) | second | **high** | https://kie.ai/kling-3-0 — "Standard: no-audio 14 credits ($0.07) /s" |
| `video.pro` | 18 cr ($0.09) | second | **high** | https://kie.ai/kling-3-0 — "Pro: no-audio 18 credits ($0.09) / s" |
| `video.4K` | 67 cr ($0.335) | second | **high** | https://kie.ai/kling-3-0 — "4K: no/with audio 67 credits ($0.335) /s" |
| `sol.call` | 0.84–6.72 cr ($0.004–$0.034) | call | **medium — derived** | https://kie.ai/gpt-5-6 rates + one measured run |

Four things in that table are worth reading twice.

**`sol.call` is derived, not quoted, and that is why it is a range.** kie.ai publishes gpt-5-6-sol
at 280 credits per 1M input tokens and 1680 per 1M output tokens. What it does not publish is how
many tokens a storyboard costs. One measured run came to ~3–4k tokens total and the input/output
split was not recorded — which matters, because output is 6× input and Sol is a reasoning model,
so reasoning tokens land in the output column. The honest bound is therefore the whole envelope:
3k all-input (0.84 cr) to 4k all-output (6.72 cr). It is around 1% of a typical run either way,
but the way to say that is a range, not a rounded-down "free". The scripts never print "free" for
it; they print "under a cent" only when the arithmetic actually says so.

**The video rates are the no-audio column.** `tween.mjs` sends `sound: false`, so those are the
correct ones — and they are the cheaper ones. kie.ai quotes 20 cr ($0.10)/s std and 27 cr
($0.135)/s pro with audio. If anyone ever turns sound on, every estimate here understates the real
bill by a third at pro — 18 → 27 cr/s, so what you actually pay is 50% above the quote — and by
30% at std (14 → 20 cr/s, a 43% uplift). Nothing fails while that happens, which is why the audio
figures are recorded rather than dropped.

**`video.4K` is the flag that changes a decision.** 67 cr/s is 3.7× pro. A six-step storyboard —
five 5 s segments, 25 s of video — goes from ~$2.55 to ~$8.68 on that one flag. It is also
almost always wasted here, because `build-frames.mjs` downscales every frame to `--width` (1600
by default) anyway.

**Beware "27 credits/second" from third-party summaries.** Kling's *own* platform has a separate
credit denomination, and 27 is a common quote in it. It is not kie.ai credits, and it collides
numerically with kie.ai's pro-*with-audio* figure, so it is unusually easy to import the wrong
one. Only figures read off kie.ai's own pages belong in this table.

A note on corroboration, because it cuts the other way from the usual warning: earlier
third-party summaries of Kling-on-kie.ai quoted ~$0.07/s std and ~$0.09/s pro, and a reseller
quoted $0.075/s. The first two agree exactly with kie.ai's own page. That agreement is why these
rows are marked high rather than medium — but the page is the source, and the summaries are not
cited as one.

### What a run adds up to

Computed by `scripts/pricing.mjs` on 2026-08-07 at 2K stills, 5 s clips, one Sol call. N steps
means N−1 video segments.

| Steps | Segments | std | pro | 4K |
|---:|---:|---:|---:|---:|
| 4 | 3 | ~$1.25 | ~$1.55 | — |
| 6 | 5 | ~$2.05 | ~$2.55 | ~$8.68 |
| 8 | 7 | ~$2.85 | ~$3.55 | — |
| 10 | 9 | ~$3.65 | ~$4.55 | — |

Each total is the low end of the estimate's range; the high end is about 3 cents more, and all of
that spread is `sol.call`. Marginal costs: one keyframe at 2K is ~$0.05, one pro 5 s segment is
~$0.45, and supplying a real "after" photo with `--ref2` removes one still (~$0.05) because it is
copied in rather than generated.

### `creditsConsumed` is the only figure that is not an estimate

Everything above predicts. The task detail (`recordInfo`) returns `creditsConsumed`, and that is
what you were actually billed. The scripts persist it:

- `keyframes/_state.json` — per image, assigned after the state record is rebuilt so a `--only`
  re-render can never leave the previous render's figure beside a new image.
- `segments/_state.json` — per segment, alongside the `duration` and `mode` it was generated at,
  so "was 3 s cheaper than 5 s" is answerable from your own runs.

The dashboard at kie.ai/logs is the ultimate source of truth if a bill looks wrong.

### Where the numbers surface

| Script | What it prints |
|---|---|
| `pricing.mjs` | The table above with provenance, an example run, and how to pin your own rates. `--self-test` checks the arithmetic offline — no network, no key. |
| `doctor.mjs` | Balance in credits and dollars, a priced default run, the full rate table, and the age of the rates. Empty account = failure; balance below the run's high end = warning. |
| `storyboard.mjs` | A whole-run forecast before the Sol call, plus the balance. Informational — no gate, because the Sol line is the smallest in the forecast. |
| `keyframes.mjs` | The cost of exactly the stills this run will pay for, the basis, the source, the balance, and a stop-and-think block if the balance will not cover it. Then `confirm()`. |
| `tween.mjs` | The same shape for video, plus the frame arithmetic; then `confirm()`, then the measured spend and a calibration line at the end. |

Both spend gates take `--yes` for non-interactive runs. With no TTY and no `--yes`, `confirm()`
neither hangs nor auto-approves: it prints the exact command with `--yes` appended and stops.

## Overriding the rates

Nobody on a different billing tier should be stuck with these numbers, and nobody should have to
edit `pricing.mjs` to escape them.

Precedence, strongest first. Each tier fills in only the keys it names, so pinning one rate
leaves the rest of the table alone:

1. a `rates` object handed straight to an estimate function (in-process callers only)
2. `SSH_RATES` — inline JSON in the environment
3. `SSH_RATES_FILE` — path to a JSON file
4. `./ssh-rates.json` in the working directory
5. the built-in table

`SSH_RATES` beats the file deliberately: the file is a standing default somebody set months ago,
the environment variable is what they typed for this run.

Keys may be nested or dotted, and a value may be a bare number, a `[low, high]` pair, or
`{low, high}` / `{credits}`:

```bash
SSH_RATES='{"video":{"pro":16},"image":{"2K":8}}'
SSH_RATES='{"video.4K": 40}'
SSH_RATES='{"creditUsd": 0.0045}'          # a bonus-credit top-up SKU
```

```powershell
$env:SSH_RATES = '{"video":{"pro":16},"image":{"2K":8}}'
```

Two guards worth knowing about, both of which print rather than silently correcting:

- **Every row except `creditUsd` is denominated in CREDITS.** There is deliberately no `{"usd":
  n}` form, because `{"video":{"pro":{"usd":0.09}}}` — the correct dollar figure — would read as
  0.09 *credits* per second and price a run at 1/200th of its real cost. A key ending `.usd`,
  `.dollars` or `.price` is rejected by name with the credits form spelled out.
- **`creditUsd` is dollars per credit** (0.005), not credits per dollar (200). The inversion
  would multiply every dollar figure by 40,000, so anything ≥ 1 is refused.

A malformed override is never silently dropped and never fatal. It is recorded and printed once —
somebody who pinned a rate did it because ours is wrong for them, and quietly reverting would
price their run at a number they had already rejected. `doctor.mjs` surfaces the same messages as
WARN lines at preflight.

## Calibration: how the table corrects itself

An estimate that never learns is a guess forever. Because `creditsConsumed` is recorded per item,
each run can check the table against the bill:

1. After generating, the script rebuilds an estimate for the items that were actually **billed** —
   not the ones ordered. Comparing a five-segment prediction against a two-segment bill would
   announce "the rate table is 60% high", which is precisely the confident wrong number this
   whole arrangement exists to prevent.
2. The observed credits are compared against the **nearest edge** of the estimate's range, not
   its midpoint. A range is a claim that the truth lies inside it, so an observation inside it
   scores zero delta rather than "7% off the middle".
3. Inside 15%, it prints one line saying the table held.
4. Outside 15%, it names the measured per-unit rate and prints the `SSH_RATES` line — in both
   bash and PowerShell form — that pins it.

Video is measured per **second** (from each segment's recorded duration), because that is the
unit Kling's rate is quoted in; measuring per segment instead is how a calibration reports a 5×
error that is not there.

So the correct response to "the bill did not match" is not to distrust the figure — it is to run
the line the script printed. Vendor prices move, and a table that only ever gets updated by
somebody re-reading a marketing page is a table that goes stale. `doctor.mjs` also warns once the
built-in rates are more than 120 days old, stated as an age rather than a date so it means
something to a reader in 2027.

## Credit balance

`GET /api/v1/chat/credit` → credits remaining on the account.

Probed unauthenticated on 2026-08-07 and the route **exists**: HTTP 200 with a body `code` of
401, which is this API's way of saying "route is here, credentials are not". The control matters
as much as the probe — `/api/v1/common/credit` answered a real HTTP 404, so the 401 is a signal
and not a catch-all. `doctor.mjs` includes this route in its preflight probes, so a moved billing
endpoint is distinguishable from a bad key.

**The success body shape is NOT verified**, because reading it costs a key. The parser accepts a
bare number at `data`, or any of `remainingCredits`, `credits`, `credit`, `balance`, `remaining`,
`quantity`, `amount` (numbers, or numeric strings). `remainingCredits` leads that list because it
is the wording kie.ai's own dashboard uses — a hint about their vocabulary, not a verified field
name, which is why the others stay. When it recognises none of them it reports "balance unknown"
rather than guessing. An invented balance would be worse than no balance.

The lookup **fails soft, always**: one attempt, 8 s deadline, no retry, and every failure — no
key, timeout, HTML interstitial from a proxy, unrecognised body — degrades to
`{known: false, reason}`. A balance exists to inform a spend gate; the day it starts blocking one
it has become a liability. `doctor.mjs` treats an unknown balance as a NOTE and does not count it
against the preflight, but a confirmed **zero or negative** balance is a failure, because the run
would die at its first call.

## Gotchas that cost real time

**File upload is on another host.** `kieai.redpandaai.co`, not `api.kie.ai`. See
[File upload](#file-upload) — this is the one contract in this document that was wrong, and the
symptom is a 404 on the very first call of a run.

**`resultJson` is a string.** It looks like an object in the docs' pretty-printed examples but
arrives JSON-encoded. `JSON.parse` it, then read `resultUrls`.

**200 ≠ done.** See above. Poll.

**A timeout is not a failure.** If polling gives up, the task may still be generating. Query
`recordInfo` with the saved taskId before creating a replacement, or you are billed twice.
`tween.mjs` deliberately writes every taskId to `segments/_state.json` for this reason.

**Uploads expire in 24 h; generated results are kept 14 days.** Long-running or resumed
sessions need re-uploads, and nothing kie.ai holds is durable storage — download during the run.

**`duration` is a string.** See above. This is the single most likely thing to fail on a first
integration, and the 422 it produces does not name the offending field.

**Error codes worth recognising.** They arrive as a body `code`, not an HTTP status:
`401` bad key · `402` **insufficient credits** · `422` validation · `429` rate limited ·
`433` sub-key limit · `455` maintenance · `500` server · `501` generation failed ·
`505` feature disabled. `kie.mjs` maps these to readable messages; 402 in particular is worth
recognising instantly, because it means nothing was generated and nothing was charged.

**Where to check spend.** Per-task credit consumption is on the task detail (`creditsConsumed`)
and in the dashboard at kie.ai/logs, which is the source of truth if a bill looks wrong. The
scripts *do* carry a rate table now — see [What it costs](#what-it-costs) — but it is dated,
sourced per row, overridable, and calibrated against `creditsConsumed` after every run. An
estimate that names its own provenance is a different thing from a hard-coded rate, and the
distinction is the point: a gate nobody can see the size of is a gate nobody can give informed
consent at.

**Aspect ratio and resolution interact.** Some combinations silently clamp. If a keyframe comes
back at an unexpected size, check the pairing against the list above before blaming the prompt.
