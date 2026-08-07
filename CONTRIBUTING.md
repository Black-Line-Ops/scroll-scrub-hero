# Contributing

Bug reports, reproductions and patches are all welcome. Read the first section before you write
any code, because the obvious way to test a change to this repo is to run the pipeline, and the
pipeline bills your card.

## Contributing without spending money

Every full run pays kie.ai three times: a reasoning call for the storyboard, one image render per
keyframe, and one video render per segment. A naive regression test — "change something, run it
end to end, see if it still works" — costs real credits every single time, and a flaky test costs
them repeatedly. **Do not verify a change by running the paid pipeline unless the change is
specifically in the paid path and you have decided to pay for it.**

Almost nothing needs a live run. Here is what to do instead.

### 1. Run the offline tests

```
npm test
```

or, identically, `node test/run.mjs`. There is no `npm install` step — see the zero-dependency
rule below — so this works on a clean checkout with nothing but Node 18+.

Eleven of the tests drive real ffmpeg and **skip themselves** if it is missing, which the exit code
cannot tell you apart from a pass. Before you open a pull request, prove they ran:

```
SSH_REQUIRE_FFMPEG=1 npm test
```

That fails outright rather than skipping. Without it, a green suite covers neither the
stale-`config.js` removal nor the trailing-frame drop.

**Every test must be offline.** A test that reaches the network is a test that can bill someone,
and it will be rejected on that ground alone even if it passes.

`scripts/kie.mjs` is the sole HTTP client for the whole pipeline; all four paid scripts go through
one `req()` at `scripts/kie.mjs:87`. If your change needs recorded kie.ai responses replayed back,
that chokepoint is where a fixture switch belongs — one insertion point covers every script. Do
not add a second HTTP call site somewhere else.

### 2. Generate synthetic footage for the ffmpeg half

`scripts/build-frames.mjs` never talks to kie.ai. It only needs an mp4, and it does not care where
the mp4 came from:

```
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=5" -c:v libx264 -pix_fmt yuv420p seg.mp4
```

Colour bars are genuinely better than real footage for this, not merely cheaper: the moving
diagonal makes frame-to-frame stepping visible at a glance, so you can see whether the sampler
spans the whole clip or just its opening second. (This recipe also appears in
`examples/pools-pavers-patios.md`, where it was first written down.)

Two variations worth knowing:

* **Truncate a clip** to exercise the shortfall guard — `-t 1.5` on a segment the storyboard
  believes is 5 s reproduces the "16 real frames padded to 40" bug that used to ship at exit 0.
* **Fake a segment index** by hand-writing `segments/_state.json` and `storyboard.json`. Both are
  small JSON files, and a mismatch between them is precisely the class of bug that shipped a hero
  with a missing chapter. You do not need any video to test the cross-check that catches it.

### 3. Preflight is free

```
node scripts/doctor.mjs
```

It checks Node, ffmpeg, ffprobe and libwebp, and probes the kie.ai routes. The route probes are
sent **unauthenticated on purpose**: a route that exists answers 401, a route that has moved
answers 404, and neither costs a credit. That distinction is how the upload-host bug was found
without spending anything, and it is a good tool to keep reaching for.

### 4. If you truly must run the paid path

Use the smallest storyboard that exercises the bug (`--steps 3`, which is two segments), run
`tween.mjs` with `--only` so you regenerate one segment instead of all of them, and say in your
PR what it cost. Never remove or loosen a confirmation prompt, a spend gate or a cost line to make
your test more convenient; those exist because someone was surprised by a bill.

## Hard constraints

These two are not preferences. A PR that breaks either will be asked to change, however good the
change is otherwise.

### Zero dependencies, zero build step

Every import in every script is a Node builtin — `node:fs`, `node:path`, `node:os`,
`node:crypto`, `node:child_process` — and it stays that way. This repo ships as a folder dropped
into a skills directory on someone else's machine; there is no install step there to run, so a
`node_modules` requirement would not merely be heavier, it would not work at all. `package.json`
exists for `engines` and the test script and has no `dependencies` field.

So: no npm packages, no bundler, no transpiler, no TypeScript, no test framework. Node 18+
builtins only (`fetch`, `node:test` and `node:assert` are all available and all fair game).

### Windows parity

Windows is a first-class target, not a port. `doctor.mjs` installs ffmpeg with `winget`; the
README documents PowerShell key-setting first. Consequences for a patch:

* Any command you **print to the user** must run in `cmd.exe` or PowerShell. `| grep` does not
  exist there — `build-frames.mjs` branches on `os.platform()` to print `findstr /i webp` instead.
  A remedy the reader cannot paste is worse than no remedy.
* Build paths with `path.join`. Never concatenate with `/`.
* No shell interpolation of paths — subprocesses use `execFileSync` with an argument array, which
  also keeps a space or a quote in a Windows path from becoming an injection.
* If you can only test on one OS, say which in the PR.

## Style

There is no linter and none is planned. Match the surrounding code: 2-space indent, single quotes,
no semicolons, LF line endings (`.editorconfig` enforces the whitespace half).

Comments in this repo explain **why**, usually by naming the failure the code prevents, in the
past tense, with the symptom the user actually saw. That register is deliberate — several of these
scripts fail in ways that look like someone else's fault, and the comment is the only thing that
tells the next reader where to look. Please write in it. A comment claiming something is fixed,
with no test behind it, is worse than no comment; if you assert a fix, add the test.

## Pull requests

* One defect or one feature per PR.
* Say how you verified it, and whether that verification cost anything.
* If the change touches a kie.ai request or response shape, update `references/kie-api.md` in the
  same PR. Code and docs diverging there is how the upload endpoint stayed wrong.
* Add an entry to `CHANGELOG.md` under `Unreleased`.
* User-visible changes should bump `.claude-plugin/plugin.json` — a marketplace client compares
  that version to decide whether an installed copy is current.
