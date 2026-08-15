# Changelog

Notable changes to this skill. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions match `.claude-plugin/plugin.json`, because a Claude Code marketplace client compares that
number to decide whether an installed copy is current.

No changelog was kept before this file existed, so the `1.0.0` entry below is a summary of what
was in the repo at that point rather than a record written as it happened. Everything under
`Unreleased` is first-hand.

## [Unreleased]

### Added

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
