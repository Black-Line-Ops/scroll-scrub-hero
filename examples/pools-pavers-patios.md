# Worked example — Pools Pavers & Patios

The hero this skill was extracted from. A visitor lands on a patch of grass and scrolls; the
pool is excavated, steeled, shelled, finished and filled in front of them. The camera never
moves.

These are the real numbers from the shipped build, not a synthetic demo — useful mostly as a
sanity check on what "normal" looks like when you run your own.

## Shape

Six stages, so six clips. Note that this build predates the current pipeline: it was cut from
six independently generated clips rather than from five first/last-frame tweens between six
keyframes. If you rebuild it with the skill today you get **N keyframes → N−1 clips**, so seven
keyframes would give you the same six chapters.

| Clip | Kicker | Caption | Frames |
|---|---|---|---|
| clip1 | 01 · The site | Every great pool starts as a patch of grass. | 49 |
| clip2 | 02 · Excavation | We dig, frame, and reinforce for Florida soil. | 49 |
| clip3 | 03 · Steel | Rebar and plumbing, engineered to code. | 37 |
| clip4 | 04 · Shell & deck | Gunite shell, tiled spa, and travertine decking. | 37 |
| clip5 | 05 · Finish | PebbleSheen interior, smooth and true. | 37 |
| clip6 | 06 · Dive in | Fill it, balance it, then dive in. | 37 |

**246 frames, 29.5 MB, 960×960 WebP.**

## What the numbers tell you

**~123 KB per frame.** That is the figure to hold in your head. The skill's default budget is
35 MB, and this build sits under it at 29.5 MB. Frames are the entire page weight of a scrub
hero, so this is the number that decides whether it feels instant or sluggish on a phone.

> **On the unit**, because this page is made of measured numbers and one of them was wrong here.
> The real total is **30,895,088 bytes**. `build-frames.mjs` divides by 1048576 and prints "MB",
> so what it actually reports is **MiB** — 29.46, hence 29.5. In decimal MB, the unit a browser's
> network panel uses, the same bytes are **30.9 MB** at 125.6 kB per frame. An earlier version of
> this page mixed the two, quoting the decimal total next to the binary per-frame figure. Both
> conventions are defensible; using one and labelling it is not optional.

**960×960 square was a mistake.** Squares forced a fit-by-height letterbox on wide screens, and
the page needed a separate extended backdrop image behind the canvas to fill the gap. Generate
**16:9** and you skip that whole problem — which is why the skill defaults to it.

**A 37-frame hold on frame 1.** `HOLD0 = 37` repeats the first frame before the sequence starts
moving, so the intro headline has scroll distance to be read before anything changes. Without
it the very first scroll pixel already advances the build and the opening copy never lands.
This exists because the source footage opened mid-dig rather than on the untouched yard — if
your first keyframe is a genuine resting state, you need far less of it.

**The last 16% of scroll is reserved.** `HOLD = 0.16` holds the finished frame while the closing
call-to-action comes up, so build progress maps to `scrollProg / (1 - HOLD)` rather than to raw
scroll.

## Settings that would reproduce this today

```bash
node "$SKILL/scripts/storyboard.mjs" \
  --ref /abs/path/backyard.jpg \
  --idea "bare grass through excavation, steel, gunite shell, finish, to a filled pool" \
  --steps 7

# approve the contact sheet, then

node "$SKILL/scripts/tween.mjs" --storyboard storyboard.json --mode pro --duration 5 --yes

node "$SKILL/scripts/build-frames.mjs" \
  --segments segments/ --storyboard storyboard.json \
  --out /abs/path/site/assets/hero-scroll/frames/ \
  --width 1600 --per-clip 41 --var PPP_HERO
```

`--per-clip 41` × 6 clips ≈ 246 frames, matching the original. At 1600×900 rather than 960×960
the frames are wider but similar in weight, and no backdrop hack is needed.

`--var PPP_HERO` because that page's existing engine reads `window.PPP_HERO_SEQ`. On a new
build, leave it at the `HERO` default.

## Frames are not in this repo

Deliberately. They are 30 MB of client project imagery — wrong to put in git, and not ours to
redistribute. If you want to see the hero, look at the live preview; if you want frames to test
`build-frames.mjs` against without spending credits, generate throwaway footage:

```bash
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=24:duration=5" -c:v libx264 -pix_fmt yuv420p seg.mp4
```

Colour bars are genuinely better for testing the cutting step than real footage — the moving
diagonal makes frame-to-frame stepping visible at a glance, so you can confirm the sampler
spans the whole clip instead of just the opening second.
