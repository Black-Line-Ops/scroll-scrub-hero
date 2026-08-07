# scroll-scrub-hero

<!-- Before changing the line below to a <video>: that has been tried and reverted (69011b2,
     b7ce8d6). GitHub strips autoplay from author markup, and strips a <video> pointing at a
     file in this repo outright, so an animated image is the only thing that plays by itself.
     That evidence, the click-to-play alternative, and why the source is 600px wide are all in
     docs/readme-reel.md. Read it before reopening this. -->

<img src="docs/examples-reel.gif" width="100%" alt="Three scroll-scrub heroes playing one after another">

<sub>Three heroes built with this technique, scrubbing back to back — Pools Pavers &amp; Patios,
Abracadabra and American Floor Scraping. Real recordings, not highlight edits: every one is
driven at the same constant <b>400&nbsp;px/second</b>, roughly the pace of an unhurried
browsing scroll, so the clip lengths differ because the heroes do.
This plays by itself, and GitHub puts a pause button on it. Open the
<a href="docs/examples-reel.mp4">full-quality MP4</a> to scrub it frame by frame.
Measurements and case studies in <a href="examples/">examples/</a>.</sub>

Turn one photo of a real place into a hero section where **scrolling drives a transformation** —
bare yard becomes a finished pool, empty room becomes a staged interior, raw stock becomes a
machined part. The camera holds still; the subject changes.

Built by [Black Line Design](https://blacklinedesign.website). This is the same pipeline behind
the scroll heroes on our client sites, packaged so you can run it yourself.

---

## What it actually does

You give it a photograph and a sentence. It:

1. **Writes a storyboard** — a multimodal model looks at your photo and plans the steps.
2. **Renders keyframe stills** — image-to-image *from your photo*, so the real building, fence
   and skyline stay recognisable instead of drifting into generic AI scenery.
3. **Stops and shows you a contact sheet.** Nothing expensive happens until you approve.
4. **Tweens between approved stills** with Kling's first/last-frame video model.
5. **Cuts the videos into numbered WebP frames** plus a small `config.js`, and can wire the
   canvas scrub engine into your page.

The finished hero is just images a canvas paints. No video element, no runtime AI, no streaming
— which is why it scrubs smoothly, works offline once deployed, and doesn't stall on iOS.

## Installing it

Works in Claude Code, Codex, Cursor and most other `SKILL.md`-compatible agents. Pick whichever
line matches your setup.

### Any agent — the skills CLI

Installs into whichever agents it finds on your machine (75+ supported, Codex and Cursor
included). It will ask which ones to target if it can't tell.

```bash
npx skills add Black-Line-Ops/scroll-scrub-hero
```

For Codex this lands in `.agents/skills/` for the project, or `~/.codex/skills/` globally.

### Claude Code — as a plugin

```
/plugin marketplace add Black-Line-Ops/scroll-scrub-hero
/plugin install scroll-scrub-hero@scroll-scrub-hero
```

### Claude Code — from a `.skill` file

Open it with Claude (drag it in, or use the **Save skill** button when Claude shows it). It
installs into your profile and is available in every project.

### By hand

Drop the folder into your agent's skills directory and restart it.

| | |
|---|---|
| Claude Code (macOS / Linux) | `~/.claude/skills/scroll-scrub-hero/` |
| Claude Code (Windows) | `C:\Users\<you>\.claude\skills\scroll-scrub-hero\` |
| Codex (project) | `.agents/skills/scroll-scrub-hero/` |
| Codex (global) | `~/.codex/skills/scroll-scrub-hero/` |

`SKILL.md` must sit at the top level of the `scroll-scrub-hero` folder — not nested inside a second
folder of the same name, which is the usual unzip accident.

Note where it landed. Everything below addresses the scripts through a `SKILL` variable holding
that path, which is what lets you run them from your own project directory instead of from inside
the skill. Setting it, and the one command that checks the whole install, are in **Setup** below.

## What you need

| | |
|---|---|
| **Node 18+** | for the scripts (`node --version`) |
| **ffmpeg + ffprobe** | for cutting frames — `winget install Gyan.FFmpeg`, `brew install ffmpeg`, or `apt install ffmpeg` |
| **A kie.ai account with credits** | this is where the models run |

## Setup

Get an API key from **kie.ai → API keys**, then set it as an environment variable.

**Windows PowerShell** — this terminal only:
```powershell
$env:KIE_API_KEY = "your-key-here"
```

**Windows PowerShell** — permanently, then reopen your terminal:
```powershell
[Environment]::SetEnvironmentVariable("KIE_API_KEY","your-key-here","User")
```

**macOS / Linux / Git Bash** — this shell only:
```bash
export KIE_API_KEY="your-key-here"
```

**macOS / Linux** — permanently:
```bash
echo 'export KIE_API_KEY="your-key-here"' >> ~/.zshrc
```

Then point `SKILL` at the folder you installed into and run the preflight. This is the only check
this README asks you to run — it covers the install, the tools and the key in one command:

```bash
# macOS / Linux / Git Bash
SKILL="$HOME/.claude/skills/scroll-scrub-hero"                 # adjust to where it landed
node "$SKILL/scripts/doctor.mjs"
```

```powershell
# Windows PowerShell
$SKILL = "$env:USERPROFILE\.claude\skills\scroll-scrub-hero"   # adjust to where it landed
node "$SKILL/scripts/doctor.mjs"
```

It verifies Node, ffmpeg, that your ffmpeg can actually encode WebP, your key, that kie.ai
accepts it, and that every route the pipeline calls still exists — and prints the exact fix for
anything missing. The scripts only ever READ the key from the environment — they never write it anywhere. Your
shell may still record the command in its history: on macOS/Linux a leading space usually
keeps it out, and the PowerShell `SetEnvironmentVariable` form stores it in your user
environment rather than a file.

## Using it

Easiest way is to just ask Claude, in a project where the skill is installed:

> Build me a scroll hero from `photos/backyard.jpg` — bare grass through to a finished pool
> with water in it, six steps.

Claude reads the skill and drives the pipeline, stopping at the contact sheet for your approval.

To drive it by hand instead — **run all four from the same scratch directory**, never from inside
the skill folder, and use absolute paths for anything outside it:

```bash
mkdir -p ~/scrub/jones && cd ~/scrub/jones
SKILL="$HOME/.claude/skills/scroll-scrub-hero"    # PowerShell: $SKILL = "$env:USERPROFILE\.claude\skills\scroll-scrub-hero"

node "$SKILL/scripts/storyboard.mjs"   --ref /abs/path/photo.jpg --idea "bare grass to finished pool" --steps 6
node "$SKILL/scripts/keyframes.mjs"    --storyboard storyboard.json     # then open keyframes/contact-sheet.html
node "$SKILL/scripts/tween.mjs"        --storyboard storyboard.json --mode pro --duration 5 --yes
node "$SKILL/scripts/build-frames.mjs" --segments segments/ --storyboard storyboard.json --out /abs/path/site/assets/hero-scroll/frames/
```

That last line is long on purpose. A trailing `\` to wrap it is a bash-ism, and this project
supports PowerShell, where the paste would break.

Staying in one directory matters: the scripts record their progress in `_state.json` files
beside their output, and that is also what lets you resume a run instead of paying twice.

The two steps that spend credits ask before doing it. When something other than a person at a
keyboard is running them — Claude, a script, CI — there is nothing to answer the prompt, so they
take `--yes`. Treat it as signing for the cost.

## Choosing a photo

This matters more than any setting.

- **Wide beats tight.** A shot with buildings, a fence and a horizon gives the model landmarks
  to hold onto. A tight crop of a lawn gives it nothing, and the sequence drifts.
- **Even, flat light.** Harsh shadows move as the model invents, which reads as a time jump.
- **One clear subject area** that will change, with everything else static.
- **Two photos are better than one.** If you have a genuine before *and* after of the same
  view, pass both (`--ref2`) — the pipeline pins the last keyframe to the real finished photo
  instead of imagining it.

## Cost

You pay kie.ai directly for what you generate. A typical six-step hero is a handful of stills
plus five video segments — the stills are cheap, the video is the real cost. Two habits keep it
sane: approve the contact sheet before tweening, and regenerate single items (`--only 3`)
rather than whole batches. Check current per-model pricing on kie.ai — the scripts deliberately
do not hard-code a rate, so they print exactly what is about to be generated rather than a dollar
figure, and wait for confirmation before spending. What they do record is whatever kie.ai reports
as `creditsConsumed`, per segment, in `segments/_state.json`, so what a run cost is something you
can look up afterwards instead of estimate.

## If something looks wrong

| Symptom | Cause | Fix |
|---|---|---|
| Hard cut mid-scroll | two keyframes disagree structurally | regenerate the later one, or insert an intermediate step |
| Subject drifts over the sequence | compounding error from chaining | re-anchor that keyframe to the original photo |
| Furniture/objects "grow" out of the floor | motion prompt isn't physical | describe one process with real verbs |
| Hero feels heavy on mobile | too many frames or too wide | lower `--per-clip` or `--width` |
| A task never finishes | it may still be running | query the saved taskId before regenerating, or you pay twice |

More detail lives in `references/prompting.md` (getting good frames) and
`references/hero-wiring.md` (getting it into a page).

## Licence

MIT — see [LICENSE](LICENSE). Use it on client work freely, commercial or otherwise. If it is
useful, a mention is appreciated but not required.
