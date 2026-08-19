<div align="center">

# scroll-scrub-hero

### Scrolling drives a real transformation — one photo in, a scrubbing hero out

Bare yard becomes a finished pool. Empty room becomes a staged interior. The camera holds still;
the subject changes.

<br>

**[Get started](#installing-it)** · **[Case studies](examples/)** ·
**[How it works](docs/how-it-works.md)** · **[What it costs](#cost)** ·
**[New to Claude Code?](https://blacklineops.ai/claude-code-guide)**

</div>

<!-- Before changing the line below to a <video>: that has been tried and reverted (69011b2,
     b7ce8d6). GitHub strips autoplay from author markup, and strips a <video> pointing at a
     file in this repo outright, so an animated image is the only thing that plays by itself.
     That evidence, the click-to-play alternative, and why the source is 600px wide are all in
     docs/readme-reel.md. Read it before reopening this. -->

<img src="docs/examples-reel.gif" width="100%" alt="Scroll-scrub heroes playing one after another">

<sub>Heroes built with this technique, scrubbing back to back. Real recordings, not highlight
edits: every one is driven at the same constant <b>400&nbsp;px/second</b>, roughly the pace of an
unhurried browsing scroll, so the clip lengths differ because the heroes do.
This plays by itself, and GitHub puts a pause button on it. Open the
<a href="docs/examples-reel.mp4">full-quality MP4</a> to scrub it frame by frame.
Measurements and case studies in <a href="examples/">examples/</a>.</sub>

<div align="center">
<br>

[![Licence](https://img.shields.io/badge/licence-MIT-EF4444?style=for-the-badge)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.3.0-2563EB?style=for-the-badge)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-0891B2?style=for-the-badge)](#what-you-need)
[![Tests](https://img.shields.io/badge/tests-290%20passing-D946EF?style=for-the-badge)](test/)
[![Powered by kie.ai](https://img.shields.io/badge/powered%20by-kie.ai-2563EB?style=for-the-badge)](https://kie.ai?ref=da271de69b92c3461d59a15884817078)

[![Claude Code](https://img.shields.io/badge/Claude%20Code-ready-D97757?style=flat-square)](#installing-it)
[![Codex](https://img.shields.io/badge/Codex-ready-06B6D4?style=flat-square)](#installing-it)
[![Cursor](https://img.shields.io/badge/Cursor-ready-7C3AED?style=flat-square)](#installing-it)
[![Windows](https://img.shields.io/badge/Windows-supported-0078D4?style=flat-square)](#setup)
[![macOS](https://img.shields.io/badge/macOS-supported-8E8E93?style=flat-square)](#setup)
[![Linux](https://img.shields.io/badge/Linux-supported-FCC624?style=flat-square)](#setup)

</div>

---

> [!NOTE]
> **You'll need a [kie.ai account](https://kie.ai?ref=da271de69b92c3461d59a15884817078)** — that's
> where the models run, and you pay them directly. A typical hero is **about $2.55**. That link is
> a Black Line Ops affiliate link: sign up through it and we earn a referral credit at no extra
> cost to you. It changes nothing about what a run costs, and the rates quoted in
> [`references/kie-api.md`](references/kie-api.md#what-it-costs) cite kie.ai's own pages with
> plain, unreferred links so you can check every number.

## 🎬 What it actually does

You give it a photograph and a sentence — or, if the thing does not exist yet, just the
sentence. It:

0. **Draws the opening frame**, when there is no photo. The idea becomes a photographic
   description, the description is rendered, and the storyboard is then written *against that
   frame*. One image, about $0.05. Skip this step and everything below is identical.
1. **Writes a storyboard** — a multimodal model looks at your photo and plans the steps.
2. **Renders keyframe stills** — image-to-image *from your photo*, so the real building, fence
   and skyline stay recognisable instead of drifting into generic AI scenery.
3. **Stops and shows you a contact sheet.** Nothing expensive happens until you approve.
4. **Tweens between approved stills** with Kling's first/last-frame video model.
5. **Cuts the videos into numbered WebP frames** plus a small `config.js`, and can wire the
   canvas scrub engine into your page.

The finished hero is just images a canvas paints. No video element, no runtime AI, no streaming
— which is why it scrubs smoothly, works offline once deployed, and doesn't stall on iOS.

<details>
<summary><b>Which of the two skills do I want?</b></summary>

<br>

Ask whether the camera moves.

| | **scroll-scrub-hero** (this one) | **scroll-flight** *(coming soon)* |
|---|---|---|
| Camera | locked, one fixed viewpoint | travels through a world |
| Subject | the subject changes state | the world holds still, you fly |
| Starts from | one or two real photographs | an idea, no photo needed |
| Good for | before → after, bare yard → finished pool | "fly through our factory / city / process" |

</details>

## 🗺️ Repo map

| | |
|---|---|
| [`SKILL.md`](SKILL.md) | what Claude reads — the interview, then the pipeline |
| [`scripts/`](scripts) | storyboard → keyframes → tween → build-frames, plus `doctor.mjs` and `pricing.mjs` |
| [`references/`](references) | [prompting](references/prompting.md), [page wiring](references/hero-wiring.md), [the kie.ai contract and cost model](references/kie-api.md) |
| [`examples/`](examples) | four real client builds, measured — frame counts, weights, what went wrong |
| [`scripts/seams.mjs`](scripts/seams.mjs) | measures every join and names the segment to re-run |
| [`test/`](test) | 290 tests, no network, nothing billable |
| [`docs/how-it-works.md`](docs/how-it-works.md) | why the frames approach beats seeking a video |

## 📦 Installing it

Works in Claude Code, Codex, Cursor and most other `SKILL.md`-compatible agents. Pick whichever
line matches your setup.

<details open>
<summary><b>Any agent — the skills CLI</b> <i>(easiest)</i></summary>

<br>

Installs into whichever agents it finds on your machine (75+ supported, Codex and Cursor
included). It will ask which ones to target if it can't tell.

```bash
npx skills add Black-Line-Ops/scroll-scrub-hero
```

For Codex this lands in `.agents/skills/` for the project, or `~/.codex/skills/` globally.

</details>

<details>
<summary><b>Claude Code — as a plugin</b></summary>

<br>

```
/plugin marketplace add Black-Line-Ops/scroll-scrub-hero
/plugin install scroll-scrub-hero@scroll-scrub-hero
```

</details>

<details>
<summary><b>Claude Code — from a <code>.skill</code> file</b></summary>

<br>

Open it with Claude (drag it in, or use the **Save skill** button when Claude shows it). It
installs into your profile and is available in every project.

</details>

<details>
<summary><b>By hand</b></summary>

<br>

Drop the folder into your agent's skills directory and restart it.

| | |
|---|---|
| Claude Code (macOS / Linux) | `~/.claude/skills/scroll-scrub-hero/` |
| Claude Code (Windows) | `C:\Users\<you>\.claude\skills\scroll-scrub-hero\` |
| Codex (project) | `.agents/skills/scroll-scrub-hero/` |
| Codex (global) | `~/.codex/skills/scroll-scrub-hero/` |

`SKILL.md` must sit at the top level of the `scroll-scrub-hero` folder — not nested inside a
second folder of the same name, which is the usual unzip accident.

</details>

Note where it landed. Everything below addresses the scripts through a `SKILL` variable holding
that path, which is what lets you run them from your own project directory instead of from inside
the skill.

## 🧰 What you need

| | |
|---|---|
| **Node 18+** | for the scripts (`node --version`) |
| **Git** | the skills CLI clones this repo to install it (`git --version`) |
| **ffmpeg + ffprobe** | for cutting frames — `winget install Gyan.FFmpeg`, `brew install ffmpeg`, or `apt install ffmpeg` |
| **A kie.ai account with credits** | this is where the models run — **[sign up](https://kie.ai?ref=da271de69b92c3461d59a15884817078)** |

No npm install. Every import is a Node builtin.

> **Never set any of this up before?** The
> **[plain-English starter guide](https://blacklineops.ai/claude-code-guide)** walks through installing all of it from
> scratch on Windows or Mac, including what a terminal is. Skip it if none of that is news.

## 🔑 Setup

Get an API key from **[kie.ai](https://kie.ai?ref=da271de69b92c3461d59a15884817078) → API keys**,
then set it as an environment variable.

<details open>
<summary><b>Windows PowerShell</b></summary>

<br>

This terminal only:
```powershell
$env:KIE_API_KEY = "your-key-here"
```

Permanently, then reopen your terminal:
```powershell
[Environment]::SetEnvironmentVariable("KIE_API_KEY","your-key-here","User")
```

</details>

<details>
<summary><b>macOS / Linux / Git Bash</b></summary>

<br>

This shell only:
```bash
export KIE_API_KEY="your-key-here"
```

Permanently:
```bash
echo 'export KIE_API_KEY="your-key-here"' >> ~/.zshrc
```

</details>

Then point `SKILL` at the folder you installed into and run the preflight. This is the only check
this README asks you to run — it covers the install, the tools and the key in one command:

Set it to **the folder the skill actually landed in** — the one holding `SKILL.md`. The table
above lists where each host installs; if you are not sure, run the preflight from inside that
folder once and it prints the exact line to use.

```bash
# macOS / Linux / Git Bash
SKILL="/absolute/path/to/scroll-scrub-hero"
node "$SKILL/scripts/doctor.mjs"
```

```powershell
# Windows PowerShell
$SKILL = "C:\absolute\path\to\scroll-scrub-hero"
node "$SKILL/scripts/doctor.mjs"
```

The first thing it checks is that path. It works out where it is running from, names the install
it recognises, prints a ready-to-paste `SKILL=` line for both shells, and fails if `$SKILL` is
already pointing somewhere else — a run split across two copies of the skill is the version of
this mistake that does not announce itself.

It verifies Node, ffmpeg, that your ffmpeg can actually encode WebP, your key, that kie.ai accepts
it, and that every route the pipeline calls still exists — and prints the exact fix for anything
missing. It then shows the money: your credit balance in credits and dollars, what a default run
costs, and every rate with the page it was read from. **None of that spends anything.**

> [!IMPORTANT]
> The scripts only ever **read** the key from the environment — they never write it anywhere. Your
> shell may still record the command in its history: on macOS/Linux a leading space usually keeps
> it out, and the PowerShell `SetEnvironmentVariable` form stores it in your user environment
> rather than a file.

## ▶️ Using it

Easiest way is to just ask Claude, in a project where the skill is installed:

> Build me a scroll hero from `photos/backyard.jpg` — bare grass through to a finished pool
> with water in it.

**You do not need to know what a keyframe is.** Claude runs a short interview first — six
multiple-choice questions about what you want, each option priced, each with a recommended default
you can just take — then shows you the forecast, drives the pipeline, and stops at the contact
sheet for your approval before anything expensive happens.

<details>
<summary><b>Driving it by hand</b></summary>

<br>

**Run all four from the same scratch directory**, never from inside the skill folder, and use
absolute paths for anything outside it:

```bash
mkdir -p ~/scrub/jones && cd ~/scrub/jones
SKILL="/absolute/path/to/scroll-scrub-hero"       # the folder holding SKILL.md; doctor.mjs prints this line for you

node "$SKILL/scripts/storyboard.mjs"   --ref /abs/path/photo.jpg --idea "bare grass to finished pool" --steps 6
node "$SKILL/scripts/storyboard.mjs"   --idea "empty lot to finished house" --steps 6      # no photo: frame 1 is generated
node "$SKILL/scripts/keyframes.mjs"    --storyboard storyboard.json     # then open keyframes/contact-sheet.html
node "$SKILL/scripts/tween.mjs"        --storyboard storyboard.json --mode pro --duration 5 --yes
node "$SKILL/scripts/build-frames.mjs" --segments segments/ --storyboard storyboard.json --out /abs/path/site/assets/hero-scroll/frames/
```

That last line is long on purpose. A trailing `\` to wrap it is a bash-ism, and this project
supports PowerShell, where the paste would break.

Staying in one directory matters: the scripts record their progress in `_state.json` files beside
their output, and that is also what lets you resume a run instead of paying twice.

</details>

> [!WARNING]
> The two steps that spend credits ask before doing it. When something other than a person at a
> keyboard is running them — Claude, a script, CI — there is nothing to answer the prompt, so they
> take `--yes`. **Treat it as signing for the cost.**

## 📷 Choosing a photo

This matters more than any setting.

- **Wide beats tight.** A shot with buildings, a fence and a horizon gives the model landmarks to
  hold onto. A tight crop of a lawn gives it nothing, and the sequence drifts.
- **Even, flat light.** Harsh shadows move as the model invents, which reads as a time jump.
- **One clear subject area** that will change, with everything else static.
- **Two photos are better than one.** If you have a genuine before *and* after of the same view,
  pass the second to `storyboard.mjs --ref2` — the pipeline pins the last keyframe to the real
  finished photo instead of imagining it, and copies it in rather than paying to generate it.
  (`--ref2` goes on `storyboard.mjs` only; `keyframes.mjs` reads it back out of `storyboard.json`.)

## 💵 Cost

You pay [kie.ai](https://kie.ai?ref=da271de69b92c3461d59a15884817078) directly for what you
generate. **A typical six-step hero is about $2.55** — a handful of stills at 5 cents each, plus
five video segments at about 45 cents each. The stills are cheap; the video is the whole bill.

| Six steps, 2K stills, 5 s clips | Estimate |
|---|---|
| Rough test (`--mode std`, 1280×720) | ~$2.05 |
| Final (`--mode pro`, 1920×1080) — the default | **~$2.55** |
| `--mode 4K` (3840×2160) | ~$8.68 |

Four steps is about $1.55 and ten is about $4.55, at final quality. Every figure here is an
**estimate** from a dated rate table read off kie.ai's own pages on 2026-08-07 — not a quote.

Before it spends, each script prints what it is about to generate, what that should cost in credits
and dollars, the arithmetic behind the number, the page the rate came from, and your account
balance — then waits for a yes. `node scripts/doctor.mjs` shows all of that for free before you
start. What gets *recorded* is whatever kie.ai reports as `creditsConsumed`, per item, in
`keyframes/_state.json` and `segments/_state.json`; the run compares that against the estimate when
it finishes and tells you how to pin your own rate if the table is off for your account.

Two habits keep it sane: approve the contact sheet before tweening, and regenerate single items
(`--only 3`) rather than whole batches. The full cost model, with the provenance of every rate and
how to override them, is in [`references/kie-api.md`](references/kie-api.md#what-it-costs).

## 🩺 If something looks wrong

| Symptom | Cause | Fix |
|---|---|---|
| Hard cut mid-scroll | two keyframes disagree structurally | regenerate the later one, or insert an intermediate step |
| Subject drifts over the sequence | compounding error from chaining | re-anchor that keyframe to the original photo |
| Furniture/objects "grow" out of the floor | motion prompt isn't physical | describe one process with real verbs |
| Hero feels heavy on mobile | too many frames or too wide | lower `--per-clip` or `--width` |
| A task never finishes | it may still be running | query the saved taskId before regenerating, or you pay twice |

More detail lives in [`references/prompting.md`](references/prompting.md) (getting good frames)
and [`references/hero-wiring.md`](references/hero-wiring.md) (getting it into a page).

## 🖤 Built by Black Line Design

We are a Tampa Bay web studio. This skill is the same pipeline behind the scroll heroes on our
client sites — packaged, documented and given away, because the interesting part was never the
code. If you want one of these built for you rather than building it yourself, that is what we do.

<div align="center">
<br>

[![Website](https://img.shields.io/badge/blacklinedesign.website-101820?style=for-the-badge&logo=googlechrome&logoColor=white)](https://blacklinedesign.website)
[![Black Line Ops](https://img.shields.io/badge/blacklineops.ai-ff8200?style=for-the-badge)](https://blacklineops.ai)

[![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat-square&logo=github&logoColor=white)](https://github.com/Black-Line-Ops)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=flat-square&logo=linkedin&logoColor=white)](https://www.linkedin.com/company/blacklineops/)
[![YouTube](https://img.shields.io/badge/YouTube-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://youtube.com/@blacklineopsllc)
[![Instagram](https://img.shields.io/badge/Instagram-E4405F?style=flat-square&logo=instagram&logoColor=white)](https://www.instagram.com/blacklineops.llc/)
[![Facebook](https://img.shields.io/badge/Facebook-1877F2?style=flat-square&logo=facebook&logoColor=white)](https://www.facebook.com/profile.php?id=61591659974557)

</div>

### 💼 Need one built instead?

This is the whole pipeline, free, MIT. But if you would rather not run it yourself — or you want
the hero designed into a page rather than dropped into one — that is the day job. Rates and contact
are on **[blacklinedesign.website](https://blacklinedesign.website)**.

## 👥 Contributor recognition

Special thanks to **[Titus Byron (@Prxdigy-exe)](https://github.com/Prxdigy-exe)**, Security Analyst Intern at Black Line Ops. Titus contributed debugging, security hardening, operational support, and fixes for several important issues in `scroll-scrub-hero`.

## 💜 Support Black Line Ops

`scroll-scrub-hero` is free and MIT-licensed. If this project saved you time or helped you build something, you can support its continued development:

<div align="center">
  <a href="https://blacklineops.ai/support">
    <img src="https://img.shields.io/badge/SUPPORT_BLACK_LINE_OPS-DC2626?style=for-the-badge&logo=stripe&logoColor=white" alt="Support Black Line Ops">
  </a>
  <br>
  <sub>Support is completely optional. This project remains free.</sub>
</div>

## ⚖️ Licence

MIT — see [LICENSE](LICENSE). Use it on client work freely, commercial or otherwise. If it is
useful, a mention is appreciated but not required.

<div align="center">
<sub>kie.ai links in this README are affiliate links — they cost you nothing extra.</sub>
</div>
