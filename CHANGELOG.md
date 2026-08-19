# Changelog

Notable changes to this skill. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions match `.claude-plugin/plugin.json`, because a Claude Code marketplace client compares that
number to decide whether an installed copy is current.

No changelog was kept before this file existed, so the `1.0.0` entry below is a summary of what
was in the repo at that point rather than a record written as it happened. Everything under
`Unreleased` is first-hand.

## [Unreleased]

## [1.2.0] — 2026-08-19

### Added

- **Build from nothing.** `storyboard.mjs` no longer requires `--ref`. With only `--idea`, it asks
  Sol for a photographic description of the opening state, renders that as the first frame, and
  then writes the storyboard *while looking at the frame it is describing*. Two Sol calls in that
  order, not one: asking for both at once produces a set of keyframe prompts written against a
  scene that does not exist yet, and an opening frame with a different fence and a different sun
  than every prompt meant to describe it. The frame lands beside the storyboard as
  `<out>.seed.png` and is recorded in `_meta.ref`, so from the second call onwards a seeded run
  and a photographed run are the same run and nothing downstream needed to learn a second mode.
  Costs one image, about $0.05, quoted on its own line in the forecast — and quoted as money spent
  *here* rather than money still to approve, which is why it carries its own estimate kind.
- **`--dry-run`, on all three scripts that spend.** Prints the plan and the whole bill, sends
  nothing, charges nothing. On `keyframes.mjs` and `tween.mjs` it prints the *assembled* prompts
  that would go on the wire — camera lock, anchor clause, art direction and all — not just the
  sentence from the storyboard, which was about a fifth of the real request. It beats `--yes` on
  the same command line, because `--yes` is the flag an agent adds by habit and a preview that can
  be argued into a purchase is not a preview. Registered once in kie.mjs's shared boolean table
  rather than three times, so it cannot mean different things in different places.
- **`--style "<one line>"`.** Art direction, carried to every frame. Written to `sb.style` from the
  flag rather than from the model's reply, and appended by `keyframes.mjs` to every prompt it
  sends — so the frame Sol forgot to style still gets styled. It matters most on a seeded run:
  with a photo, the photo is the art direction; with nothing, two runs of the same idea come back
  looking like two different companies.
- **`--float`.** Renders onto a flat key-colour field (magenta by default — green loses to
  vegetation, blue loses to sky, and sky is in shot on nearly every outdoor run) and keys it to
  transparency in the pass that was already cutting the frames. The subject then sits *on* the
  page rather than inside a rectangle. No new dependency: no Python, no segmentation model, no
  per-frame inference. `config.js` gains `window.<VAR>_ALPHA=true`. `--float-tolerance` exists
  because Kling animates the flat field too and compression leaves a halo of near-key pixels;
  the contact sheet is where you find out, and re-running that stage costs nothing.
- **Frame shape is now read off the footage.** `build-frames.mjs` had no concept of one:
  `scale=W:-2` is correct arithmetic and silent about everything else. It now probes the segments,
  writes `window.<VAR>_ASPECT` into `config.js` so the page can size the scrub container before a
  frame has decoded, and treats `--aspect` as a **check** rather than an instruction — refusing
  when it disagrees with the real footage, which is what catches a mobile build pointed at the
  desktop segments. That failure previously produced a config that loads, a page that renders and
  a hero that is quietly the wrong one.

- **A fifth worked example, Common Ground Remodelers** — 160 frames, 26.9 MB, 172 KB/frame at
  1600×900, in `examples/README.md`. It is there to separate two things the file previously ran
  together. American Floor Scraping is 16:9 at 84 KB/frame; this is 16:9 at 172, and the 2.05×
  decomposes as 1.56× the pixels multiplied by 1.31× the cost per pixel. That second factor is
  shingles, foliage, aggregate and a gravel lawn all sharp front to back, which no encoder
  setting makes cheap — so "generate 16:9" sets the shape and the subject decides the rest.
  Piccs Pools now carries a pointer to that qualifier.
- It is also the only example not resting on client photography. The source is a single generated
  still, so it is the one sequence in the file a reader can reproduce end to end and check their
  own numbers against — which is why the examples index now reads "four shipped on real client
  sites, and one reference build" rather than claiming a fifth client.
- **The header reel now plays four heroes** rather than three, adding the same sequence at the
  end. Its pin runway measured 3,312 px, so it runs 8.28 s at the 400 px/second the other three
  are driven at, and that claim stays literally true rather than approximately. Reel 21.84 s →
  30.12 s; GIF 5.4 MB → 7.6 MB, which is the extra runtime and not a worse encode — 42.8 KB per
  frame against the old 42.0. The caption above it stops enumerating the sites instead of growing
  a fourth name, so nothing in the top-level README needed to change but the count.

### Changed

- **The mobile question is now always asked.** There is no defensible silent default: a 16:9 hero
  on a phone is a letterbox strip, and the centre-crop most builds fall into throws away both
  sides of every frame — which on this pipeline is where the change is happening. Round 2 of the
  interview grew from two questions to four (look, quality, phones, page weight); round 1 gained a
  fourth option on Q1 for having no photo at all.
- **`--width` follows the frame shape when omitted.** 1600 landscape, 900 portrait. The old flat
  1600 default applied to a 9:16 run emitted 1600×2844 frames — four times the pixels of the
  desktop set, for a viewport around 390 CSS px wide. Nothing failed; the budget line just said a
  number nobody could explain. An explicit `--width` is still obeyed, and values below 64 are now
  refused: the shared parser catches `--width wide`, but only this knows that 8 is a number and a
  useless frame width.
- **`keyframes.mjs` defaults its aspect and resolution from the storyboard** before falling back to
  16:9/2K, so a portrait run stays portrait instead of changing shape at step 2 and handing Kling
  two differently-shaped frames for every tween.
- **The prompt sent to kie.ai is assembled in one named place** rather than inline at the call
  site. That is what made an honest `--dry-run` possible.
- **The interview asks the subject question open**, and offers the brand/look question three ways —
  a path, a description, or nothing. Asked as a demand, people go and find a photo of something
  else, and a hero anchored to the wrong building is worse than one drawn from a sentence.

### Fixed

- **`$SKILL` no longer assumes Claude Code.** The docs told everyone to set it to
  `~/.claude/skills/scroll-scrub-hero`, which is wrong for Codex — `~/.codex/skills/` globally,
  `.agents/skills/` per project — and the failure was `Cannot find module` on the very first
  command, naming a module rather than the folder that was actually wrong. `doctor.mjs` now works
  out where it is running from, names the install it recognises, prints a ready-to-paste `SKILL=`
  line for both shells, and **fails** when `$SKILL` points somewhere else, because a run split
  across two copies of the skill is the version of this mistake that does not announce itself. Its
  closing "start with" line is now the absolute path too — the bare `node storyboard.mjs` it used
  to print only worked from inside `scripts/`, and anyone standing there wrote their outputs into
  the installed skill. SKILL.md, README.md and AGENTS.md stop hardcoding a path they cannot know.

## [1.1.0] — 2026-08-07

> Version bumped because `1.0.0` could not complete a run. Anyone who installed before this could
> not tell a fixed copy from a broken one, since the manifest still claimed `1.0.0` while `main`
> carried every fix below. If you have an older copy, reinstall.

Two independent audits of `1.0.0` found that a cold start could not complete a single run: three
defects sat in strict series on the path before the first billable call, each masking the next.
None of them cost money — the run died before spending any — but nobody could get past step 1.
Those are fixed here, along with the deliverable-quality and spend-visibility problems the same
audits turned up.

### Fixed

* **The file upload posted to the wrong host.** `POST https://api.kie.ai/api/v1/file-base64-upload`
  returns 404, and so does the same path without `/v1` — the route lives on a different host
  entirely, `https://kieai.redpandaai.co/api/file-base64-upload`. `storyboard.mjs` uploads the
  reference photo as its first action after the key check, so every cold start died within
  seconds, with an HTTP 404 that never printed the URL it had called. The other two routes really
  are on `api.kie.ai`, which is why the base URL was never suspected.
* **`storyboard.mjs` passed an upload record where a URL string belonged.** `uploadFile()` returns
  `{ url, uploadedAt }`; every other caller unwrapped it. The malformed payload came back as an
  HTTP 500, which the client treats as retryable, so the user watched four retries over 22 seconds
  and read it as a kie.ai outage.
* **Non-JSON responses were swallowed into `{}`.** A failed JSON parse silently produced an empty
  object with `res.ok` still true, so a transport-level failure surfaced as
  `sol returned no text: {}` and pointed the reader at the model. Requests now send
  `Accept: application/json` and an explicit `stream: false`, and a parse failure names the
  content-type it actually received.
* **A retried create could be billed twice.** `req()` retried everything five times. A create is
  not idempotent and kie.ai accepts no idempotency key, so a create whose response was lost could
  be paid for more than once. Creates are no longer retried; reads keep the five attempts.
* **`doctor.mjs` certified a machine that could not run.** Preflight probed exactly one route —
  `recordInfo`, the only one of the four that both existed and is never touched first — then
  printed `All good. Start with:` above the command that died four lines later. All four routes
  are now probed, unauthenticated: a route that exists answers 401, a route that has moved answers
  404, and neither costs a credit.
* **XSS from model output into the approval contact sheet.** `keyframes.mjs` interpolated
  model-written labels and captions, and the operator-typed `--ref2` filename, into
  `contact-sheet.html` unescaped, at six sinks — including `<title>`, where RCDATA ends at the
  first `</title>` and an injected `<script>` lands in `<head>` and runs before the page renders.
  Everything now goes through `esc()`, and the page carries a `default-src 'none'` CSP so nothing
  can execute or phone home even if an escape is missed. See `SECURITY.md`.
* **A hero could ship with a chapter missing, at exit 0.** `build-frames.mjs` numbered output
  directories positionally but looked captions up by content, and never consulted `sb.motions` —
  the only record of how many segments should exist. One absent segment slid every later caption
  one chapter out of place and the run reported success. Segments described by the storyboard with
  no video are now an error; `--allow-gaps` (new) restores the old behaviour for the
  bring-your-own-clips path, and says out loud that the hero will have a hole in it.
* **The frame-count pad loop was unbounded.** A truncated clip yielding 16 real frames was topped
  up to 40 by repeating the last one 25 times — a chapter frozen for 62% of its scroll, at exit 0.
  A shortfall past 10% now stops the build and names the likely cause.
* **`ffprobe` reporting `"N/A"` for duration.** The string is truthy, so the fallback written for
  exactly that case never ran; `dur` became `NaN`, and ffmpeg's rejection of `-vf fps=NaN` arrived
  with its stderr swallowed.
* **ffmpeg failures were unreadable.** `execFileSync` output was captured and never printed, so a
  missing libwebp encoder surfaced as `Command failed`, a raw buffer and a stack trace, at the end
  of a run that had already paid for both generation steps. Failures now print ffmpeg's own
  explanation, and the encoder check they suggest is a command that runs on the reader's platform
  (`findstr` on Windows, `grep` elsewhere).
* **A malformed storyboard discarded a paid response.** Model output that parsed as JSON but was
  structurally wrong died on a stack trace, taking the response with it. Sol's output is now
  validated field by field at the boundary, and unparseable output is written to disk instead of
  being lost.
* **A hand-edited storyboard with two motions sharing a `from` step** would pay for two Kling
  renders and keep one: state is keyed by that number, so the second overwrote the first. Now
  rejected before anything is billed.
* **`--only` naming a segment that does not exist** filtered the work list to empty and reported
  "every segment already has a video on disk" at exit 0 — the opposite of the truth, at the moment
  an operator decides whether the run is finished. A mistyped id is now a stop.
* **`--duration 4.5`** was silently floored by `parseInt` and then billed at a length nobody chose.
* **`--var` was interpolated into generated JavaScript unvalidated.** The realistic failure is not
  an attack but `--var hero-scroll`, which emits `window.hero-scroll_SEQ=[`, throws on the live
  page, and lets the build print a full success summary.

### Added

* `tween.mjs` records `creditsConsumed` per segment — kie.ai has always returned it and this
  pipeline discarded it — alongside the duration it was generated at, and prints a per-run total.
  The cost of a given `--duration` is now something you can look up rather than model.
* `tween.mjs` prints the frame arithmetic before you confirm: how many frames a segment renders at
  ~24fps versus the 40 `build-frames.mjs` keeps by default, so the surplus you are paying for is
  visible. Deliberately **not** a pricing claim — the default `--duration` is unchanged, because
  nothing in this repo establishes that Kling bills per second rather than in duration bands.
* `build-frames.mjs --allow-gaps`, for building from whatever clips exist.
* Repo scaffolding: `package.json` (no dependencies — every import is a Node builtin),
  `SECURITY.md`, `CONTRIBUTING.md` including the no-spend contribution path, this file, `.nvmrc`
  and `.editorconfig`.
* A test suite where there was none: 178 tests, no dependency, no network, nothing billable. Every
  fix above was mutation-checked — reverted in a scratch copy to confirm the suite goes red — so
  none of them rests on a comment asserting it works.
* `SSH_REQUIRE_FFMPEG=1` turns a missing ffmpeg into a test failure instead of eleven silent skips.
  Without it a green suite covers neither the stale-`config.js` removal nor the trailing-frame drop,
  and the exit code cannot tell you that. Use it in CI and before a release.
* **Cost estimation in credits and dollars, with an approval gate that knows your balance.** Every
  rate is quoted verbatim from kie.ai's own pages (1 credit = $0.005; Kling 14 cr/s std, 18 pro,
  67 at 4K, no-audio; GPT Image 2 at 6/10/16 cr for 1K/2K/4K) with the source and date recorded per
  row. `doctor.mjs` shows your balance, each paid stage prices only the work it will actually do,
  and a run that exceeds your balance says so before you answer y/n. Override the table with
  `SSH_RATES` if you are on a discounted tier.
* **`pollTask` now reports `creditsConsumed`.** It accepted an `onMeta` callback from two callers
  and never invoked it, so the figure was silently dropped and the reconciliation the gates promised
  never ran. Runs now record what they actually cost and say when the built-in estimate is off.
* **A guided interview.** `SKILL.md` now opens with batched multiple-choice questions phrased as
  outcomes rather than flags, each option carrying its own price, so the pipeline can be driven by
  someone who has never heard of a keyframe. The flag-level docs are still there underneath.

### Notes

* The trailing frame of each clip is still dropped, deliberately: it is the destination keyframe,
  byte-identical to the next clip's frame 1, and keeping it would hold the seam for one frame.
  This was reported as a bug; it is the fix.
* `config.js` is written with `JSON.stringify`, which does not escape `</script>`. As shipped it
  is loaded with `<script src>`, where that is harmless — do not inline it into a page. See
  `SECURITY.md`.

## [1.0.0] — 2026-08-05

First public release: the complete photo → storyboard → keyframes → tween → frames pipeline on
kie.ai, the drop-in scroll-scrub engine, `doctor.mjs` preflight, the Claude Code plugin and
marketplace manifests, `SKILL.md`, and the pools-pavers-patios worked example.

Published without tests, and — as the Unreleased section above records — without ever having been
run cold from a clean checkout by someone who was not its author.

Dated from the first commit. The manifest stayed at `1.0.0` through fourteen commits and no tag
was ever cut, so anyone who installed early has no way to tell their copy from `8f6ffd2`; this
entry covers the whole of that range. Bump the manifest on every user-visible change from here.
