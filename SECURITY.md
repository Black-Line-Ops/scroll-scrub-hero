# Security

This skill is unusual for a static-site tool: it holds a paid third-party API key, it renders
text written by a language model about a photograph a stranger supplied, and it writes a
JavaScript file that a live website loads. Each of those is a real boundary, and they are
described below rather than summarised, because the interesting risk here is not a memory bug —
it is text crossing from a place nobody controls into a place that executes.

## Reporting a vulnerability

Report privately, not as a public issue:

**<https://github.com/Black-Line-Ops/scroll-scrub-hero/security/advisories/new>** — GitHub's
private advisory form. Only the maintainers see it.

Please include the script, the input that triggers it, and what you saw. A reproduction that
spends no kie.ai credits is very welcome but not required — see `CONTRIBUTING.md` for the
offline fixtures. We aim to acknowledge within five working days. There is no bounty.

If the finding is in **kie.ai** itself, or in the models it fronts, report it to kie.ai. This
repo is only an HTTP client for them.

## What this project trusts, and what it does not

| Input | Trusted? | Why it matters |
|---|---|---|
| `KIE_API_KEY` (environment) | trusted | Spends real money. Never appears in a file this repo writes. |
| The photo you pass to `--ref` / `--ref2` | semi-trusted | You chose the file, but a client emailed it to you. Its **contents** are read by a model; its **filename** reaches HTML. |
| The storyboard JSON the model returns | **untrusted** | Free text. Reaches an HTML page and a `.js` file. |
| Rendered images and video from kie.ai | semi-trusted | Bytes, handed straight to ffmpeg. Never parsed by us. |
| `segments/_state.json`, `storyboard.json` on disk | trusted | Anyone who can write these already has your shell. |

### 1. The API key

`KIE_API_KEY` is read from the environment only. It is never accepted as a CLI flag, so it cannot
end up in shell history, in a `ps` listing, or in a pasted transcript of a failed command.

* It is never written to `storyboard.json`, `_state.json`, `config.js` or the contact sheet.
* `scripts/doctor.mjs` is the only place it is echoed at all, and only as the first four
  characters plus a length (`scripts/doctor.mjs:83`). Keys of twelve characters or fewer are
  never partially printed — a short mask overlaps itself and leaks the whole thing.
* `.env` and `.env.*` are gitignored. Nothing in this repo reads them; they are ignored so that
  your own habit of keeping one there cannot commit a key by accident.
* A leaked key is a spend incident, not just an access incident. Rotate it at kie.ai
  immediately; there is nothing to revoke on this side.

### 2. Model output → markup (the important one)

`scripts/keyframes.mjs` writes `keyframes/contact-sheet.html`, and the skill then tells a human to
open it in a browser and approve it. Almost everything on that page originates outside your
control:

* the labels and captions were written by a model,
* which was told to describe a photograph *faithfully*,
* which a client emailed you,
* and which may itself contain text — a sign, a plan set, a screenshot.

That is a complete path from a stranger's photograph into an HTML document you are instructed to
open. Treat the storyboard as attacker-controlled text, because functionally it is.

Two mitigations are in place and both must stay:

* **`esc()` at every sink** (`scripts/keyframes.mjs:166`). Every interpolation into the page goes
  through it, including `<title>`. `<title>` is the one that reads as harmless and is not: it is
  RCDATA, it ends at the first `</title>`, and an injected `<script>` after that lands in `<head>`
  and runs before any of the page renders.
* **A restrictive CSP `<meta>`** (`scripts/keyframes.mjs:194`):
  `default-src 'none'; img-src 'self' file: data:; style-src 'unsafe-inline'`. No script of any
  origin can run, and nothing on the page can make a network request, so a payload that survives
  the escaping still cannot exfiltrate. `style-src 'unsafe-inline'` is required because the sheet
  carries its own `<style>` block; it is the weakest clause and is deliberate.

The `--ref2` **filename** is on this path too. It is operator-typed rather than model-written,
which is exactly why it was missed once: a file genuinely named `after.jpg" onerror="alert(1)`
breaks out of an attribute even when the model output is clean. It is escaped like everything
else.

If you add a field to the contact sheet, it goes through `esc()`. There is no second rule.

### 3. Generated `config.js` → a live website

`scripts/build-frames.mjs:264-267` writes `config.js` into your site's asset folder, and your page
loads it. The captions in it are model-written, so this is the same untrusted text arriving on a
production domain.

* Values are serialised with `JSON.stringify`, which handles quotes, backslashes and control
  characters.
* **`JSON.stringify` does not escape `</script>`.** As shipped, `config.js` is a separate file
  loaded with `<script src>`, where that does not matter. It becomes a real breakout the moment
  someone inlines the file's contents into an HTML `<script>` block — a very ordinary
  build-step optimisation. Don't inline it. If your build must, escape `<` on the way in.
* `--var` is validated against a JavaScript identifier pattern before it is interpolated into
  `window.<prefix>_SEQ` (`scripts/build-frames.mjs:38`). That check exists mostly to catch
  `--var hero-scroll`, but it closes the injection too.

### 4. Uploads leave your machine

`scripts/kie.mjs` base64-encodes the photo you pass and POSTs it to kie.ai. That is the whole
point of the tool, but say it plainly to a client before you run it: **their photograph is sent
to a third party and processed by models.** Read kie.ai's terms for retention and training. This
repo makes no promise on their behalf.

### 5. Subprocesses

`ffmpeg` and `ffprobe` are invoked with `execFileSync` and an argument array — never through a
shell, never with string concatenation — so a filename containing shell metacharacters is passed
as one argument rather than interpreted. Keep it that way; a switch to `execSync` would turn every
path in this pipeline into a command-injection sink.

## Not in scope

* Anything requiring an attacker who can already write to your working directory or read your
  environment.
* kie.ai account security, billing limits and rate limits.
* The quality, accuracy or licensing of what the models generate.

## Supported versions

The `main` branch only. This is a skill folder, not a released library; there are no backports.
