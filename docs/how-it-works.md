# How it works

A one-page tour of the machinery, for when you want to change something rather than just run it.

## The shape of the problem

A scroll-scrub hero is an image sequence painted onto a canvas, with the frame index driven by
scroll position. That part is easy and has been done for years. The hard part is *producing*
a few hundred frames that read as one continuous shot of a real place changing over time.

Generating a single long video and cutting it up does not work: video models drift badly over
ten-plus seconds and you get no control over the intermediate states. Generating each frame
independently does not work either — consecutive frames disagree and the result strobes.

The middle path is a **keyframe chain**: fix a handful of states as still images, then let a
video model interpolate between consecutive pairs. You get authored control at every stage
boundary and machine-generated smoothness in between.

## Why first/last-frame is the whole design

Kling's first/last-frame mode takes two images and invents the motion between them. Its
documented failure mode is a **lens switch** — when the two images differ too much it stops
interpolating and cuts. Everything in this skill exists to keep those two images similar:

- the camera is locked and repeated verbatim into every keyframe prompt
- every keyframe is generated **image-to-image from the original photograph**, so the building,
  fence and horizon are re-derived from the same source rather than re-imagined
- each keyframe also receives the **previous keyframe** as a second input, for continuity
- the storyboard is instructed to change one thing per step, so no gap is too wide

The two inputs pull in opposite directions on purpose. Original-only loses continuity between
steps; previous-only compounds drift until step six is a different property. Both together is
the stable configuration.

## Pipeline stages

| Stage | Script | Model | Cost |
|---|---|---|---|
| 1. Storyboard | `storyboard.mjs` | `gpt-5-6-sol` (chat, multimodal) | negligible |
| 2. Keyframes | `keyframes.mjs` | `gpt-image-2-image-to-image` | cheap, confirmed |
| — | *human approves a contact sheet* | — | — |
| 3. Tweens | `tween.mjs` | `kling-3.0/video` | **the real cost**, confirmed |
| 4. Frames | `build-frames.mjs` | ffmpeg, local | free |

Stage 1 uses a chat model rather than an image model because it needs to *look at* the photo and
reason about it. It cannot generate images; that is stage 2's job. Getting this backwards is an
easy mistake — Sol is listed under kie.ai's chat models, not its image models.

## State and resumption

Each stage writes a `_state.json` beside its output recording what has been produced and the
kie.ai task ids behind it. This is what makes a run resumable, and it matters more than it
sounds: a six-segment tween takes many minutes per segment, so interruptions are normal, and
re-creating a task that is still running bills you twice.

Three rules the state layer enforces:

- **A segment counts as done only when its video is on disk.** Recording a task id is not the
  same as having the file — a failed segment used to persist as "complete" and the frame builder
  would then ship a hero with a missing chapter.
- **The consumer checks too, not just the producer.** `tween.mjs` refusing to hand over a partial
  set is only half the guarantee: clips can be deleted afterwards, and the back half of the
  pipeline can be driven on its own with footage that never came from `tween.mjs` at all. So
  `build-frames.mjs` independently cross-checks what is on disk against the storyboard's
  `motions` and exits non-zero on a gap, unless `--allow-gaps` says the mismatch is intended.
  A guarantee enforced at only one end of a pipeline is not enforced.
- **A corrupt state file is fatal, not empty.** Silently treating unreadable state as "nothing
  generated" means re-paying for everything.

## Things that bite

**kie.ai reports failures inside HTTP 200.** A bad key comes back as `{"code":401}` with a 200
status. Checking `res.ok` is not enough; the client checks the body code too. This one is worth
remembering if you extend the client — it is why a dead key used to pass preflight and then hang
the poller for its full timeout.

**`resultJson` is a JSON string, not an object.** Parse it, then read `resultUrls`.

**Uploads expire after 24 hours.** The approval gate is designed to take as long as the human
needs, which routinely outlives an upload. `tween.mjs` re-uploads keyframes immediately before
using them.

**Frame count and config must agree exactly.** The page indexes frames by number, so one missing
file is a broken scrub. `build-frames.mjs` normalises the sampled count to the requested count
and writes that same number into `config.js`. Normalising has a limit, though: it pads a small
shortfall by repeating the last frame, and says how many it repeated, but a shortfall past a
tenth of the clip is treated as a truncated segment and stops the run. Padding that far does not
produce the requested count, it produces a chapter frozen for most of its scroll while
`config.js` reports a healthy number.

**File upload is on a different host from everything else.** `https://kieai.redpandaai.co`, not
`api.kie.ai`. It looks like a typo, it is not, and "correcting" it breaks every run at its first
network call. `references/kie-api.md` carries the probe output.

## Extending it

The client (`scripts/kie.mjs`) is deliberately the only thing that talks to kie.ai — retry,
pacing, body-code checking and result parsing all live there. To swap in a different video
model, change the model string and input shape in `tween.mjs`; everything downstream operates on
mp4 files and does not care where they came from.

To target a page that expects a different config shape, `--var` changes the global prefix, and
`references/hero-wiring.md` documents the exact contract plus a complete engine for pages that
have none.
