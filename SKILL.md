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

## Why the pipeline is shaped this way

Three constraints drive every decision below. Understanding them is more useful than following
the steps literally, because they tell you what to do when a run goes sideways.

**A first/last-frame chain cuts if the frames disagree.** Kling is explicitly documented to
produce a "lens switch" — a visible jump cut — when the start and end images differ too much.
So the whole approach only works if consecutive keyframes share camera position, lens, light and
composition, and differ *only* in the thing that is changing. This is why a locked-off camera
with an evolving subject is the natural fit, and why "fly the camera through a world" is not —
that wants a continuous-camera technique, not a first/last-frame chain.

**Stills are cheap, video is not.** Keyframes cost cents; Kling segments cost real money and
minutes. So the pipeline renders every still first, shows them to the human, and refuses to
spend on video until they approve. A bad keyframe caught here saves a wasted segment.

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
whatever is missing, including the per-platform commands for setting the key. If it reports
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

When a step spends credits it asks for confirmation. If a script, CI or Claude is running the
command there is no keyboard to answer with, so those steps take `--yes` — which is an explicit
"I accept the cost", not a formality. Pass it deliberately.

### 1. Gather the brief

You need: the reference photo(s), the idea in a sentence or two, and how many steps the story
has. Ask if not given. Six to eight keyframes is the sweet spot — enough to read as a
progression, few enough that each tween carries real change.

N keyframes produce **N−1** video segments and therefore N−1 scrub clips. Say this out loud to
the user when confirming the plan, because "6 steps" meaning 5 clips surprises people.

If the user supplies two photos (a genuine before and after), use them as the first and last
keyframes and have Sol invent only the middle. That is the highest-fidelity mode available —
both anchors are real.

### 2. Storyboard

```bash
node "$SKILL/scripts/storyboard.mjs" --ref /abs/path/photo.jpg --idea "<the idea>" --steps 6 --out storyboard.json
```

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

The script writes `keyframes/contact-sheet.html`. Open it and hand it to the user:

> "Here are the six keyframes. Look for anything that changed that shouldn't have — the house
> moving, the fence changing colour, a tree appearing. Tell me which numbers to redo."

Regenerate individually with `--only 3,5` and a revised prompt. Iterate here as long as it
takes. **Do not run step 4 until the user approves**, and do not offer to "just try one segment
to see" — that is how a run quietly costs triple.

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
The script also records whatever kie.ai reports as `creditsConsumed` per segment into
`segments/_state.json`, next to the duration it was generated at, so the trade is answerable from
your own runs instead of estimated.

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
above ~35 MB, drop `--per-clip` or `--width` rather than shipping it.

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

## Reference material

- `references/kie-api.md` — exact endpoints, model strings, request/response shapes, polling
  states, and the gotchas (`resultJson` is a JSON *string*; uploads expire in 24 h). Read this
  if a script errors or you need a model the scripts don't cover.
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
