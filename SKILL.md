---
name: scroll-scrub-hero
description: >
  Build a scroll-scrubbed hero from one or two REAL photos plus an idea — the kind where
  scrolling drives a subject through a transformation (bare yard → finished pool, empty room →
  staged interior, raw stock → machined part, before → after). Uses kie.ai: GPT 5.6 Sol writes
  the storyboard from the photo, GPT Image 2 image-to-image renders the keyframe stills so the
  client's ACTUAL property stays recognisable, Kling 3.0 first/last-frame tweens the motion
  between them, and ffmpeg cuts the result into drop-in scrub frames plus config.js. Use this
  whenever someone wants a scroll-driven build/progress/before-after hero, mentions scrubbing
  video on scroll, asks to "animate" a client photo into a hero, wants Kling or kie.ai wired
  into a site, or wants to turn project photos into a scrolling story — even if they don't say
  "scroll scrub". Suits a fixed camera with a subject that changes state; not a camera flying through a scene.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, WebFetch
---

# scroll-scrub-hero

Turns a real photograph into a hero where **scroll drives time**: the camera holds still and
the subject transforms. It is built as a chain of keyframe stills joined by short AI-generated
video tweens, then flattened into an image sequence the page scrubs on a canvas.

The output is deliberately boring to consume: numbered WebP frames plus a small `config.js`.
No runtime AI, no video element, no streaming — just images a canvas paints, which is why it
scrubs smoothly and works offline once deployed.

**It spends the user's money at kie.ai.** A typical run is around **$2.55**; the levers that
change that are in the interview below, and every one of them is priced. Nothing generates
without a confirmation except the storyboard call, which is under four cents.

---

# Part 1 — The interview (the front door)

**Do not ask the user for flag values.** Do not ask how many keyframes, what `--mode` to use,
or whether they want `pro`. Ask what they are trying to end up with, in outcomes, and derive
the flags yourself. Everything in Part 2 is for an expert driving this by hand.

Two rounds of `AskUserQuestion`, four questions then two. Six answers is the whole brief.

## Before round 1: get the raw material

Ask in chat, not with a question tool — these are paths and sentences, not choices:

1. **The photo** (absolute path). One is enough.
2. **One sentence on what changes.** "Bare grass to a finished pool with water in it."
3. **Where the finished hero goes** (absolute path to the site, if it is going into one).

Look at the photo before you go further. Anything you can see, you must not ask about:
the aspect ratio, whether there is a house or a fence in shot, what season it is, whether
the light is flat. Every question you ask is a chance to lose someone.

## Round 1 — the story (4 questions, one `AskUserQuestion` call)

### Q1 · header "Photos" — what have you got to work from?

*This decides how much of the finished hero is real and how much is invented.*

| Option | Description to show |
|---|---|
| One photo (the before) | The finished state is imagined by the model from your photo. This is what most jobs have and it works. Costs one extra generated still, about **$0.05**. |
| A real before AND a real after ★ | **Pick this if you have it.** The last frame is your actual finished photograph, copied in rather than invented — the client sees their real result at the end of the scroll. Saves about **$0.05** and removes the biggest source of "that's not what we built". |
| Several photos of the same view | Only the first and last are used as anchors; the ones in between are useful to me as description, not as inputs. Same cost as one photo. |

### Q2 · header "End state" — what does the FINAL frame show?

*The one detail worth pinning now. Everything else is derived from it, and getting it wrong
means regenerating the whole chain rather than one frame.*

| Option | Description to show |
|---|---|
| Finished and in use | e.g. pool full, furniture out, lights on. The most persuasive ending. The model has to invent people and props unless your "after" photo already shows them, so it is the option most likely to need a redo (about **$0.05** per still). No difference in the base cost. |
| Finished, clean and empty ★ | e.g. pool full, deck bare. **Recommended.** Least invention, so the least chance of a stage looking fake, and the cheapest to get right first time. Same cost. |
| Deliberately unfinished | Ends on the work rather than the result. Right for a trades brand selling craft over outcome. Same cost. |

Reword the examples for whatever the photo actually shows — a room, a workshop bench, a facade.
Three options phrased in pools at somebody's kitchen renovation is how an interview loses people.

### Q3 · header "Stages" — how many stages should the scroll move through?

*Each stage is one still. The movement between two stages is one video clip, and the clips are
where nearly all the money goes. N stages means **N−1** clips — say that out loud, because "six
stages" meaning five clips surprises people.*

Quote the **final-quality** column from the [forecast table](#the-forecast-table) — these are
the numbers for the recommended quality, so the user is comparing like with like:

| Option | Description to show |
|---|---|
| 4 stages — about $1.55 | 3 clips. Cheapest and quickest. Each clip has to carry a lot of change, which is exactly where visible jump-cuts come from. Fine for a simple two-act story. |
| 6 stages — about $2.55 ★ | 5 clips. **Recommended.** Enough to read as a progression, each step small enough that the video model does not have to invent. |
| 8 stages — about $3.55 | 7 clips. Smoother, more detail, a longer scroll and a heavier page. Worth it when the build genuinely has seven distinct phases. |
| 10 stages — about $4.55 | 9 clips. Nearly 80% more than six, and a longer page to download. Only when there really are ten readable phases; otherwise it reads as padding. |

### Q4 · header "Placement" — where does this live on the page?

*Sets the aspect ratio, which is baked into the stills. Changing it later means regenerating
them, which is why it is asked before anything is made rather than after.*

| Option | Description to show |
|---|---|
| Full-bleed hero, edge to edge ★ | 16:9, frames built 1600px wide. **Recommended** and by far the most common. No effect on what you pay kie.ai; it sets the page weight. |
| A boxed section inside the page | 16:9 but frames built 1200px wide. Identical generation cost, and substantially lighter to download — 1200px is 56% of the pixel area of 1600px. `build-frames.mjs` reports the real figure. |
| Tall / portrait, phone first | 9:16 or 4:5 instead of 16:9. Same cost. Say so now: the ratio is baked into every still. |

## Round 2 — the spend (2 questions, one `AskUserQuestion` call)

Round 1 fixed the stage count, so **substitute the real figures for their answer** from the
forecast table below. Do not print the six-stage numbers at someone who chose eight.

### Q5 · header "Quality" — a rough test, or the one that goes on the client's site?

| Option | Description to show |
|---|---|
| Rough test first | 1280×720 video. At 6 stages, **about $2.05**. Same composition, same story, softer. **This is not a discount** — if you then build the real one you pay for the video twice, about **$4.30** all in. Worth it when the photo is untested or the storyboard looks risky; wasteful when you are confident. |
| Final quality ★ | 1920×1080 video. At 6 stages, **about $2.55** — roughly 50 cents more than the test. **Recommended.** This is what ships. It is sharper than the frames end up needing, which is the point: downscaling hides softness. |
| 4K | 3840×2160. At 6 stages, **about $8.68** — about 3.4× what Final costs. Almost always the wrong answer here, because the last stage downscales every frame to 1600px wide anyway, so you are buying pixels that get thrown away. Only if you need the source video for something else. |

### Q6 · header "Page weight" — how heavy can the finished page afford to be?

*This one costs no credits. It spends the visitor's data instead: every frame is downloaded and
decoded by the browser before the scroll feels smooth.*

| Option | Description to show |
|---|---|
| Light — aim for 15 MB | Fewer frames per clip. Best when the site's visitors are on cellular data. The scrub is a little steppier when scrolled fast; most people do not notice. |
| Standard — aim for 30 MB ★ | **Recommended.** Our flagship build ships at 246 frames / 29.5 MB (`examples/README.md`) and reads as smooth. |
| Maximum smoothness — 45 MB+ | More frames per clip, desktop-first showcase only. The measured counter-example in this repo hit 87.5 MB, which on a phone is not a hero, it is a download. |

Do **not** convert the answer into a `--per-clip` number yourself — the bytes per frame depend on
the photo, and guessing produces a confident wrong figure. Pass the target to
`build-frames.mjs --budget-mb <n>` and let it measure: it reports the real total and, when the
build lands over budget, names the exact `--per-clip`, `--width` and `--quality` that would bring
it under. Re-running that stage costs nothing.

## The rules these questions follow

Keep them when you edit. Each one is here because breaking it produced a worse outcome.

**Every option states its consequence AND its cost.** "Final quality (about $2.55, sharper,
this is what ships)" beats "pro". A choice whose price is invisible is not an informed choice,
and this pipeline's whole failure mode is someone approving a number they never saw.

**One recommended default per question, marked.** Someone with no opinion should be able to
take every ★ and get a good hero. The ★ is not a hedge — it is the answer you would pick.

**Ask only what changes the outcome.** Anything visible in the photo, or safe as a default, is
not a question. Two things that look like decisions and deliberately are not:

- *Clip length* (`--duration`) stays at 5 s. It is a real cost lever — 3 s saves about 90 cents
  on a six-stage run — but shortening the gap is also the first cheap remedy when a seam cuts,
  so a run that starts at the 3 s floor has nothing left to shorten. And a draft rendered at a
  different length is a different shot, so it stops predicting the final.
- *Resolution of the stills* (`--resolution`) stays at 2K. It is 5 cents an image and the
  frames are downscaled anyway; there is no version of this question worth a user's attention.

**Batch them.** `AskUserQuestion` takes up to four at once. Two rounds beats six prompts, and
round 2 is separate only because it can quote real numbers once round 1 has fixed the count.

**Numbers come from the scripts, not from memory.** The table below is a copy of what
`scripts/pricing.mjs` computes; the scripts print the authoritative figure for the actual run.
If they disagree, the scripts are right and this table is stale.

## The forecast table

Generated from `scripts/pricing.mjs` on **2026-08-07**: 2K stills, 5 s clips, one Sol call,
kie.ai's own published rates. Figures are the low end of pricing.mjs's range; the high end is
about 3 cents more in every row, and all of it is the storyboard call.

| Stages | Clips | Rough test (std) | Final (pro) ★ | 4K |
|---:|---:|---:|---:|---:|
| 4 | 3 | ~$1.25 | ~$1.55 | — |
| 6 | 5 | ~$2.05 | **~$2.55** | ~$8.68 |
| 8 | 7 | ~$2.85 | ~$3.55 | — |
| 10 | 9 | ~$3.65 | ~$4.55 | — |

Adjustments worth quoting when they apply:

- **A real "after" photo** takes one still off the bill: about **$0.05** less.
- **Redoing one keyframe** is about **$0.05**. Redoing one video segment at final quality is
  about **$0.45**. Budget for one or two — the contact-sheet gate exists so you catch them
  before the expensive stage, not so that nothing is ever redone.
- These are **estimates from a rate table**, not quotes. What actually gets recorded is
  whatever kie.ai reports as `creditsConsumed`, and the run compares the two when it finishes.
  The full cost model, with the provenance of every rate, is in `references/kie-api.md`.

## Show the forecast before you generate anything

After the interview, print the run you are about to order and what it should cost, and wait.
`doctor.mjs` does this for free — no key spent, nothing created — and adds the account balance:

```bash
node "$SKILL/scripts/doctor.mjs"
```

Its money view prints the balance in credits and dollars, a priced default run, and every rate
with the page it was read from. If the balance will not cover the run it says so **before** the
first call rather than halfway through, which is the failure worth preventing: a run that dies
mid-way has been paid for and has no hero to show.

Then say back, in one short paragraph: the number of stages and clips, the quality, the aspect
ratio, the target weight, and the estimated total. Then start Part 2.

## Mapping the six answers to flags

| Answer | Where it lands |
|---|---|
| Real before + after | `storyboard.mjs --ref2 <after.jpg>` — **on storyboard only**. `keyframes.mjs` picks it up from `storyboard.json`'s `_meta.ref2` and copies it in unbilled. |
| End state | Prose in `--idea`, and a line you check on the storyboard before spending. |
| Stages | `storyboard.mjs --steps N` |
| Placement | `--aspect` on `keyframes.mjs` and `tween.mjs` (both default `16:9`), and `--width` on `build-frames.mjs` |
| Quality | `tween.mjs --mode std\|pro\|4K` |
| Page weight | `build-frames.mjs --budget-mb` — then take the `--per-clip` / `--width` / `--quality` it suggests if it lands over |

Pass the quality and stage answers to `storyboard.mjs` as well — `--mode`, `--resolution` and
`--duration` change nothing it does, they exist so the forecast it prints describes the run
that is actually going to be ordered.

---

# Part 2 — The pipeline (the expert path)

Everything below drives the scripts directly. The interview is the front door, not a
replacement: an expert can skip Part 1 entirely and start here.

## Why the pipeline is shaped this way

Three constraints drive every decision below. Understanding them is more useful than following
the steps literally, because they tell you what to do when a run goes sideways.

**A first/last-frame chain cuts if the frames disagree.** Kling is explicitly documented to
produce a "lens switch" — a visible jump cut — when the start and end images differ too much.
So the whole approach only works if consecutive keyframes share camera position, lens, light and
composition, and differ *only* in the thing that is changing. This is why a locked-off camera
with an evolving subject is the natural fit, and why "fly the camera through a world" is not —
that wants a continuous-camera technique, not a first/last-frame chain.

**Stills are cheap, video is not.** Keyframes cost 5 cents each at 2K; Kling segments cost 45
cents each at pro/5 s and take minutes. So the pipeline renders every still first, shows them
to the human, and refuses to spend on video until they approve. A bad keyframe caught here
saves a wasted segment — the gate pays for itself the first time it fires.

**Frames are the page's weight budget.** A finished sequence is hundreds of images the browser
must fetch and decode. Around 120 KB/frame at ~250 frames is already ~30 MB. Treat total weight
as a hard design input, not an afterthought — `build-frames.mjs` reports it and will warn.

## Before starting

Every command in this document invokes the scripts through `$SKILL`, so set that first. It is
the absolute path of the folder holding this `SKILL.md` — wherever the install put it:

```bash
# macOS / Linux / Git Bash
SKILL="$HOME/.claude/skills/scroll-scrub-hero"                 # adjust if installed elsewhere
```

```powershell
# Windows PowerShell
$SKILL = "$env:USERPROFILE\.claude\skills\scroll-scrub-hero"   # adjust if installed elsewhere
```

Both shells expand `$SKILL` inside double quotes, so every `node "$SKILL/scripts/…"` line below
is copy-pasteable verbatim in either one. Forward slashes are fine on Windows; Node accepts them.

Then run the preflight. It takes no arguments and works from any directory:

```bash
node "$SKILL/scripts/doctor.mjs"
```

It checks Node 18+, ffmpeg, ffprobe, that this ffmpeg actually carries the libwebp encoder step 5
depends on, `KIE_API_KEY`, whether kie.ai accepts that key, whether every route the pipeline calls
still exists, and whether the working directory is writable — then prints the exact fix for
whatever is missing, including the per-platform commands for setting the key. It then prints the
money view: your credit balance in credits and dollars, what a default run costs, and every rate
with the page it was read from and how long ago. A balance that cannot cover a default run is a
warning; an empty account is a failure, because the first call would fail anyway. If it reports
problems, work through them before going further rather than discovering them mid-run with
credits spent.

If the user has no key, point them at kie.ai → API keys and note the account needs credits. The
key is read from the environment only; never write it into a file in their repo, and never echo
it back in full.

Everything here is Node + ffmpeg on purpose. Don't reach for Python — it is frequently absent or
shimmed to a broken store alias on Windows, which is exactly the kind of thing that makes a
skill fail on someone else's machine.

## The run

**Pick one working directory and stay in it for every step.** Use a scratch directory —
`<project>/.scrub-hero/<slug>/` — not the site's asset tree; only the finished frames get copied
into the site. Pass **absolute paths** for `--out` when writing into the site, so you never have
to `cd` mid-run. Each step writes state to disk, so a run resumes after an interruption instead
of re-paying for finished work.

Every command below is written to be run from that one scratch directory, with `SKILL` set as in
[Before starting](#before-starting) — repeated in the fence because a fresh terminal loses it:

```bash
mkdir -p myproject/.scrub-hero/jones && cd myproject/.scrub-hero/jones
SKILL="$HOME/.claude/skills/scroll-scrub-hero"     # adjust if installed elsewhere
```

```powershell
New-Item -ItemType Directory -Force myproject\.scrub-hero\jones | Out-Null
Set-Location myproject\.scrub-hero\jones
$SKILL = "$env:USERPROFILE\.claude\skills\scroll-scrub-hero"
```

Nothing below ever needs a second `cd`: the scripts are addressed through `$SKILL`, and anything
written outside the scratch directory is passed as an absolute path.

When a step spends credits it asks for confirmation, printing the estimate, the arithmetic
behind it, the page the rate came from and your balance. If a script, CI or Claude is running
the command there is no keyboard to answer with, so those steps take `--yes` — which is an
explicit "I accept the cost", not a formality. Pass it deliberately.

### 1. Gather the brief

You need: the reference photo(s), the idea in a sentence or two, and how many steps the story
has. The interview in Part 1 collects exactly this. Six to eight keyframes is the sweet spot —
enough to read as a progression, few enough that each tween carries real change.

N keyframes produce **N−1** video segments and therefore N−1 scrub clips. Say this out loud to
the user when confirming the plan, because "6 steps" meaning 5 clips surprises people.

If the user supplies two photos (a genuine before and after), use them as the first and last
keyframes and have Sol invent only the middle. That is the highest-fidelity mode available —
both anchors are real — and it takes one still off the bill.

### 2. Storyboard

```bash
node "$SKILL/scripts/storyboard.mjs" --ref /abs/path/photo.jpg --idea "<the idea>" --steps 6 --out storyboard.json
```

Add `--ref2 /abs/path/after.jpg` when there is a real finished photo; that flag belongs here and
nowhere else — `keyframes.mjs` reads it back out of `storyboard.json`. The forecast-only flags
`--resolution`, `--mode` and `--duration` change nothing this script does; they make the
whole-run forecast it prints describe the run you are actually going to order.

Before it calls Sol it prints that forecast — every stage, with the total and your balance —
then makes the one call. There is deliberately **no y/n gate here**: the Sol call is the
smallest line in the forecast (under four cents) and a prompt in front of it would train people
to answer the next one by reflex, and the next one is the video bill.

Sol reads the photo and writes, for each step, a keyframe prompt (what the frame *shows*) and
for each gap a motion prompt (what *happens* between). Read `storyboard.json` and sanity-check
it against the photo before spending anything — Sol occasionally invents features the property
doesn't have, and a wrong detail here propagates through every later stage.

Show the user the step labels and captions as a short list. This is a cheap moment to catch
"actually there's no spa in this build".

### 3. Keyframes, then stop

```bash
node "$SKILL/scripts/keyframes.mjs" --storyboard storyboard.json --out keyframes/
```

Each keyframe is generated image-to-image from **the original photo plus the previous
keyframe**. The original anchors camera and architecture so the scene can't drift into a generic
AI backyard; the previous keyframe carries continuity so step 4 looks like step 3 with work
done, not a different property.

The cost line prices exactly the images this run will pay for — cached frames and a supplied
`--ref2` photo are already excluded — and warns when `--only` names a frame that is already on
disk, because that re-buys it.

The script writes `keyframes/contact-sheet.html`. Open it and hand it to the user:

> "Here are the six keyframes. Look for anything that changed that shouldn't have — the house
> moving, the fence changing colour, a tree appearing. Tell me which numbers to redo."

Regenerate individually with `--only 3,5` and a revised prompt, about 5 cents each. Iterate here
as long as it takes. **Do not run step 4 until the user approves**, and do not offer to "just
try one segment to see" — that is how a run quietly costs triple.

### 4. Tween

```bash
node "$SKILL/scripts/tween.mjs" --storyboard storyboard.json --keyframes keyframes/ --out segments/ --mode pro --duration 5 --yes
```

Uploads each adjacent pair as first/last frame with its motion prompt. Defaults are `pro`
(1920×1080 at 16:9) and 5 s.

The script prints the frame arithmetic before it spends, and it is worth reading rather than
skipping: at ~24 fps a 5 s segment renders ~121 frames and step 5 keeps 40, so ~81 per segment
are rendered, billed and thrown away. What that surplus buys is headroom above `--per-clip`;
what it costs is seconds of Kling. `--duration 3` still yields ~73, comfortably above 40 — but 3
is the API floor, and shortening the gap is also the first cheap remedy when a seam cuts
(`references/prompting.md`), so a run that already sits at the floor has nothing left to shorten.

It also records whatever kie.ai reports as `creditsConsumed` per segment into
`segments/_state.json`, next to the duration it was generated at, and when the run finishes it
compares the real bill against the estimate. If the table is off it names your measured rate and
the environment variable that pins it, so the trade is answerable from your own runs.

If you ran a `std` draft and now want the real thing, point `--out` at a **new** directory
(`--out segments-pro/`). A segment counts as done when its file is on disk, so re-running into
the same directory reports "nothing to do" and quietly ships the draft.

It re-uploads the keyframes first: kie.ai deletes uploads after 24 h, and the approval gate you
just held is exactly the kind of pause that outlives them.

Segments are independent, so a single failure is re-runnable with `--only 3` rather than redoing
the set. A segment only counts as done when its video is on disk — if any are missing the script
says so and exits non-zero, because a partial set builds a hero with a missing chapter. Step 5
checks the same thing again from the other side, so ignoring this exit code does not get you
past it; it only moves the stop later.

`--yes` is there because there is no keyboard when Claude or CI runs this. Only pass it once the
user has actually approved the contact sheet.

### 5. Cut to frames

```bash
node "$SKILL/scripts/build-frames.mjs" --segments segments/ --storyboard storyboard.json --out /abs/path/to/site/assets/hero-scroll/frames/ --width 1600 --per-clip 40
```

One line, no backslash continuation — a trailing `\` is a bash-ism and breaks the paste in
PowerShell, which is a first-class target here.

Extracts an even sample from each segment, downscales, encodes WebP, and writes `config.js`
alongside the `clipN/` directories. It reports per-clip and total weight; if the total lands
above the `--budget-mb` figure (35 MB by default) it names the smaller `--per-clip`, `--width`
and `--quality` that would bring it under. This costs nothing to re-run, so tune it here rather
than shipping something heavy.

Before it writes anything it cross-checks the segments on disk against the storyboard's
`motions`. If the storyboard describes a segment that has no video, it names the missing pairs,
prints the `tween.mjs --only N` that regenerates them, and exits non-zero — because that is the
failure that otherwise ships a hero with a chapter missing and every signal reading success.
`--allow-gaps` downgrades it to a warning; the bring-your-own-clips note in `examples/README.md`
is the one case that legitimately wants it.

Use an **absolute** `--out` so you can stay in the scratch directory. It also flags two things
worth catching here: byte-identical segments (the same motion twice, usually a stale file from
a resumed run) and any clip that yielded no frames at all.

### 6. Wire it up

Check whether the target page already consumes this shape. The `--var` prefix defaults to
`HERO`, so look for that or whatever prefix the project already uses:

```bash
grep -rn "HERO_SEQ\|hero-scroll/frames" <page>.html
```

On Windows without a POSIX shell, `Select-String -Pattern "HERO_SEQ" <page>.html` does the same.

**If it does**, you are done — the new frames and config drop straight in. Reload and scrub.

**If it doesn't**, read `references/hero-wiring.md` and add the hero section. That file has the
canvas + ScrollTrigger scrub engine, the preload/decode gate, and the caption wiring, with the
gotchas that took real debugging to find already handled.

### 7. Verify before declaring done

Scrub the hero in a browser and confirm: no visible cut at any segment seam, the frame count
matches config, and the first frame paints before the intro copy appears. If you have a
verification harness in the project, run it. A hero that looks right in a contact sheet can
still stutter on a real scroll.

Then tell the user what it actually cost. `segments/_state.json` and `keyframes/_state.json`
hold kie.ai's own `creditsConsumed` per item, and the end of the tween run prints the total in
credits and dollars. Report the measured figure, not the estimate.

## Money, in one place

- `node "$SKILL/scripts/pricing.mjs"` — the rate table with the URL every rate was read from,
  plus an example run. `--self-test` checks its arithmetic offline.
- Rates are **estimates**, dated, with a confidence per row. `references/kie-api.md` documents
  the whole cost model, where each number came from, and how to pin your own with `SSH_RATES`
  when your billing tier differs.
- Ground truth is `creditsConsumed`, recorded per item during the run, and the runs calibrate
  the table against it.

## Reference material

- `references/kie-api.md` — exact endpoints, model strings, request/response shapes, polling
  states, the cost model with per-row provenance, and the gotchas (`resultJson` is a JSON
  *string*; uploads expire in 24 h). Read this if a script errors, if you need a model the
  scripts don't cover, or if a price looks wrong.
- `references/prompting.md` — how to write keyframe and motion prompts that survive a
  first/last-frame chain. Read before writing or revising prompts by hand; this is where most
  quality problems actually live.
- `references/hero-wiring.md` — the drop-in contract (`config.js` shape, frame naming) and a
  complete scrub engine for pages that don't have one.

## When a run goes wrong

**A seam shows a hard cut.** The two keyframes disagreed somewhere structural. Regenerate the
later keyframe with the earlier one weighted more heavily in the prompt ("identical camera,
identical house, only the deck changes"), then re-tween just that segment.

**The subject drifts across the sequence.** Chaining is compounding drift. Regenerate the
offending keyframe from the *original* photo alone with an explicit description of the state it
should be in, rather than from its neighbour.

**Kling returns a lens switch anyway.** Shorten the gap: insert an intermediate keyframe so each
tween carries less change. More, smaller steps beat fewer, larger ones.

**Motion is mushy or the subject morphs.** The motion prompt is doing too much. Motion prompts
should describe *one* physical process ("the excavator digs out the shape, soil piles left"),
not a list.

**A task never completes.** Poll state is `waiting|queuing|generating|success|fail`. Polling
gives up after 10 minutes for a keyframe and 15 for a segment, and leaves the taskId in the state
file so you can query it by hand — see `references/kie-api.md`. Don't re-create a task that may
still be running; you pay twice.

**The bill did not match the estimate.** That is expected to happen eventually — vendor prices
move. The run says so at the end and prints the `SSH_RATES` line that pins your measured rate.
See the calibration section of `references/kie-api.md`.
