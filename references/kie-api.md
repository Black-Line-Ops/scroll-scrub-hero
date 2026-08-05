# kie.ai API contract

Verified August 2026. Read this when a script errors, when you need a model the scripts don't
wrap, or when you're tempted to call the API by hand.

## Contents
- [Auth and base](#auth-and-base)
- [The three-call pattern](#the-three-call-pattern)
- [File upload](#file-upload)
- [Models used by this skill](#models-used-by-this-skill)
- [Gotchas that cost real time](#gotchas-that-cost-real-time)

## Auth and base

Base URL `https://api.kie.ai`. Every request carries:

```
Authorization: Bearer $KIE_API_KEY
Content-Type: application/json
```

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

`POST /api/v1/file-base64-upload`

```json
{ "base64Data": "data:image/png;base64,...", "uploadPath": "images", "fileName": "ref.png" }
```

Returns a `fileUrl` under `data`. **Uploads are deleted after 24 hours**, which is fine inside a
run but means you cannot treat these URLs as durable. If you resume a run days later, re-upload.

## Models used by this skill

### GPT 5.6 Sol — storyboard authoring

Not a `createTask` model. It is a Responses-style endpoint that answers inline:

`POST /codex/v1/responses`

```json
{ "model": "gpt-5-6-sol",
  "input": [ { "role": "user", "content": [
      { "type": "input_text",  "text": "..." },
      { "type": "input_image", "image_url": "https://..." } ] } ],
  "reasoning": { "effort": "medium" } }
```

Effort is `low` (default), `medium`, `high`, `xhigh`. Text comes back at
`output[].content[].text` where `type === "output_text"`.

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
  "duration": 5,
  "aspect_ratio": "16:9",
  "mode": "pro",
  "sound": false }
```

- `duration` accepts 3–15 seconds.
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

**`resultJson` is a string.** It looks like an object in the docs' pretty-printed examples but
arrives JSON-encoded. `JSON.parse` it, then read `resultUrls`.

**200 ≠ done.** See above. Poll.

**A timeout is not a failure.** If polling gives up, the task may still be generating. Query
`recordInfo` with the saved taskId before creating a replacement, or you are billed twice.
`tween.mjs` deliberately writes every taskId to `segments/_state.json` for this reason.

**Uploads expire in 24 h.** Long-running or resumed sessions need re-uploads.

**Aspect ratio and resolution interact.** Some combinations silently clamp. If a keyframe comes
back at an unexpected size, check the pairing against the list above before blaming the prompt.
