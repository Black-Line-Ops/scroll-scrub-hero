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

## Contents
- [Auth and base](#auth-and-base)
- [The three-call pattern](#the-three-call-pattern)
- [File upload](#file-upload)
- [Models used by this skill](#models-used-by-this-skill)
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
and in the dashboard at kie.ai/logs, which is the source of truth if a bill looks wrong. Current
pricing is at kie.ai/pricing — these scripts deliberately never hard-code a rate. `tween.mjs`
copies each segment's `creditsConsumed` into `segments/_state.json` alongside the duration and
mode it was generated at, and prints a run total, so "was 3 s cheaper than 5 s" is answerable
from your own runs rather than from an assumed billing model.

**Aspect ratio and resolution interact.** Some combinations silently clamp. If a keyframe comes
back at an unexpected size, check the pairing against the list above before blaming the prompt.
