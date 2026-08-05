# Examples

Four scroll-scrub heroes shipped on real client sites, measured. The reel at the top of the repo
README plays the first three back to back.

The point of putting them side by side is the **weight column**. Same technique, same engine,
and a 4× spread in bytes per frame — which is entirely a function of decisions made at
generation time, not of anything the page does.

| Site | Frames | Total | KB/frame | Dimensions | What it demonstrates |
|---|---:|---:|---:|---|---|
| [Pools Pavers & Patios](pools-pavers-patios.md) | 246 | 29.5 MB | 123 | 960×960 | The full six-stage build. The flagship. |
| [Abracadabra](#abracadabra) | 149 | 12.7 MB | 88 | 1080×1348 | Portrait, narrative rather than process. |
| [T. Jones Landscaping](#t-jones-landscaping) | 126 | 18.2 MB | 148 | 1400×788 | A virtual camera pan inside a locked frame. |
| [Piccs Pools](#piccs-pools) | 246 | 87.5 MB | 364 | 1920×1920 | What happens when nobody watches the budget. |

Frames themselves are not committed — they are client imagery, they are tens of megabytes, and
neither belongs in git. These are case studies with real numbers.

---

## Abracadabra

**149 frames · 12.7 MB · 88 KB/frame · 1080×1348 portrait**

A tattoo studio. The hero is a scroll-driven illustrated sequence rather than a construction
process — proof the technique carries narrative just as well as progress.

Two things worth stealing:

**Portrait pays for itself on a phone.** At 1080×1348 the frame is taller than it is wide, so a
phone shows the whole composition instead of a centre-cropped slice. On the desktop it is
letterboxed into a wider stage, which suits an illustrated subject far better than it would a
photograph.

**88 KB/frame at 1080 wide** is the number to notice. Illustration compresses better than
photography — flat areas and clean line work are cheap in WebP. If your subject is drawn rather
than photographed, expect to land well under the 123 KB/frame a photographic sequence costs.

## T. Jones Landscaping

**126 frames · 18.2 MB · 148 KB/frame · 1400×788**

A lawn-care service. The camera is locked, as always — but this build adds a **virtual camera
pan**: the canvas painter offsets its source rectangle per frame, following the subject inside
the frame rather than showing a static crop.

That is worth understanding as a technique. The generated footage kept the worker near the edge
of frame for long stretches, which on a phone meant cropping him out entirely. Rather than
regenerate, the painter tracks a per-frame focus point and shifts the crop to keep the subject
in view. It costs nothing at generation time and rescues footage that would otherwise be unusable
in portrait.

At 148 KB/frame this is the most expensive per frame of the non-outliers — outdoor greenery with
fine texture is the hardest thing here to compress.

## Piccs Pools

**246 frames · 87.5 MB · 364 KB/frame · 1920×1920**

Included deliberately as the cautionary example. Same six-stage pool build as Pools Pavers &
Patios, same frame count — and **three times the weight**.

The whole difference is generation-time choices: 1920×1920 square frames instead of 960×960.
Doubling each dimension quadruples the pixels, and WebP does not absorb that for free. 364 KB per
frame against PPP's 123 KB, for a hero that is displayed at the same size on the same screens.

Two specific mistakes, both cheap to avoid:

1. **Square at 1920.** Square framing forces a fit-by-height letterbox on any wide screen, so
   much of that resolution is cropped away before anyone sees it. Generate 16:9.
2. **No weight check before shipping.** `build-frames.mjs` reports total weight and warns past
   35 MB precisely because this is easy to miss — a hero looks identical in a contact sheet at
   any resolution.

On a phone on cellular, 87.5 MB is not a hero, it is a download. If you take one thing from
these examples, take the weight column.

---

## A note on captions

Pools Pavers & Patios and Piccs Pools currently ship **word-for-word identical captions** —
"Every great pool starts as a patch of grass," and all five that follow. Two pool contractors in
the same market running the same script.

Worth writing fresh copy per client, and worth remembering that the storyboard step will happily hand you the same
phrasing twice if you give it the same brief twice.
