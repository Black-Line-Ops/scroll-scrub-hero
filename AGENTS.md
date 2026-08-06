# Agent instructions

This repository is an **agent skill**. The full instructions live in [`SKILL.md`](SKILL.md) —
read that first and follow it; this file exists so agents that look for `AGENTS.md` by
convention (Codex among them) find their way there.

## What it does

Turn one photo of a real place into a scroll-scrubbed hero where the camera holds still and the subject transforms.

## Before you run anything

```bash
node scripts/doctor.mjs
```

It checks Node 18+, ffmpeg, ffprobe, the `KIE_API_KEY` environment variable, and whether
kie.ai actually accepts that key — then prints the exact fix for whatever is missing. Run it
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

**Stay in one working directory.** Each step writes a `_state.json` beside its output; that
state is what lets an interrupted run resume instead of re-paying for finished work. Use
absolute paths for anything outside the working directory rather than `cd`-ing mid-run.

**Never print the API key.** It is read from the environment only. Do not echo it, do not write
it into a file in the user's repo, and do not include it in a command you show them.

## First command

```bash
node scripts/storyboard.mjs --ref /abs/path/photo.jpg --idea "bare grass to finished pool" --steps 6
```

Then follow [`SKILL.md`](SKILL.md) from step 2.

## Reference material

Read these when the task calls for it rather than up front:

- `references/kie-api.md` — exact endpoints, model strings, request shapes and the gotchas
- `references/prompting.md` — writing prompts that survive a first/last-frame chain
- `references/hero-wiring.md` — the drop-in contract and a complete scrub engine
