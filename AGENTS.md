# Agent instructions

This repository is an **agent skill**. The full instructions live in [`SKILL.md`](SKILL.md) —
read that first and follow it; this file exists so agents that look for `AGENTS.md` by
convention (Codex among them) find their way there.

## What it does

Turn one photo of a real place into a scroll-scrubbed hero where the camera holds still and the subject transforms.

## Before you run anything

This file uses the same working-directory contract as [`SKILL.md`](SKILL.md), because the two
hand off to each other mid-run and a different one here would leave the user's files in the wrong
place. It is: **one scratch directory outside the skill folder, plus `$SKILL` pointing at the
skill folder.** Set both before the first command.

```bash
mkdir -p myproject/.scrub-hero/jones && cd myproject/.scrub-hero/jones
SKILL="$HOME/.claude/skills/scroll-scrub-hero"     # adjust if installed elsewhere
```

```powershell
New-Item -ItemType Directory -Force myproject\.scrub-hero\jones | Out-Null
Set-Location myproject\.scrub-hero\jones
$SKILL = "$env:USERPROFILE\.claude\skills\scroll-scrub-hero"
```

Never run the scripts with the skill folder as the working directory. Their outputs
(`storyboard.json`, `keyframes/`, `segments/`) are written relative to the cwd, so doing that
scatters run artifacts through the user's installed skill — and `storyboard.mjs` has no cache, so
the re-run after you move them is a second billed Sol call.

Then preflight. It works from any directory:

```bash
node "$SKILL/scripts/doctor.mjs"
```

It checks Node 18+, ffmpeg, ffprobe, that this ffmpeg has the libwebp encoder the last stage
needs, the `KIE_API_KEY` environment variable, whether kie.ai accepts that key, and whether every
route the pipeline calls still exists — then prints the exact fix for whatever is missing. Run it
before the first command in any session; the alternative is discovering a missing dependency
partway through a run that has already cost the user money.

## Things worth knowing before you drive this

**It spends the user's money.** Two steps call paid APIs. Both ask for confirmation, and both
take `--yes` because there is no keyboard when an agent is running them. Only pass `--yes`
once the user has actually approved — treat it as signing for the cost, not as boilerplate.

**There is a human gate in the middle, and it is not optional.** The pipeline renders every
still first and stops at a contact sheet. Do not start the expensive step until the user has
looked at it and said go, and do not offer to "just try one" to see — that is how a run
quietly costs several times what it should.

**Stay in the one scratch directory.** Each step writes a `_state.json` beside its output; that
state is what lets an interrupted run resume instead of re-paying for finished work. Use
absolute paths for anything outside the working directory rather than `cd`-ing mid-run — that is
why the scripts are invoked as `"$SKILL/scripts/<name>.mjs"` and never as bare `scripts/…`.

**Never print the API key.** It is read from the environment only. Do not echo it, do not write
it into a file in the user's repo, and do not include it in a command you show them.

## First command

From the scratch directory set up above:

```bash
node "$SKILL/scripts/storyboard.mjs" --ref /abs/path/photo.jpg --idea "bare grass to finished pool" --steps 6
```

Quote the idea. Unquoted, every word after the first arrives as a stray argument; the parser
rejects those by name rather than storyboarding one word, but it is still a failed command.

Then follow [`SKILL.md`](SKILL.md) from step 2 — it assumes exactly the directory and `$SKILL`
you already have.

## Reference material

Read these when the task calls for it rather than up front:

- `references/kie-api.md` — exact endpoints, model strings, request shapes and the gotchas
- `references/prompting.md` — writing prompts that survive a first/last-frame chain
- `references/hero-wiring.md` — the drop-in contract and a complete scrub engine
