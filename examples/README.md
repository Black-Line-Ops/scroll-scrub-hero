# Examples

Four scroll-scrub heroes shipped on real client sites, measured. The reel at the top of the
repo README plays the first three back to back, each driven at the same 400 px/second.

The point of putting them side by side is the **weight column**. Same technique, same engine,
and a 4× spread in bytes per frame — which is entirely a function of decisions made at
generation time, not of anything the page does.

| Site | Frames | Total | KB/frame | Dimensions | What it demonstrates |
|---|---:|---:|---:|---|---|
| [Pools Pavers & Patios](pools-pavers-patios.md) | 246 | 29.5 MB | 123 | 960×960 | The full six-stage build. The flagship. |
| [Abracadabra](#abracadabra) | 149 | 12.7 MB | 88 | 1080×1348 | Portrait, narrative rather than process. |
| [American Floor Scraping](#american-floor-scraping) | 170 | 13.9 MB | 84 | 1280×720 | 16:9 done right, and per-moment pacing. |
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

## American Floor Scraping

**170 frames · 13.9 MB · 84 KB/frame · 1280×720 landscape**

A floor-removal contractor. The sequence runs eagle in profile → head-on → a push through the
eye → the grinder working a hallway → tile breaking up → out over the Gulf coast at sunrise.

**Read this one against Piccs Pools below.** Piccs is the cautionary example — 1920×1920 square,
364 KB/frame — and its advice is "generate 16:9." This is what following that advice costs:
**84 KB per frame, the lightest of the four**, on the largest pixel dimension anyone here
shipped at along the horizontal. Nothing is cropped away unseen, because the frame is already
the shape of the screen.

**Honest note on how it was made.** This one did not come out of the photo → storyboard →
keyframe path the rest of the skill describes. The client supplied six generated clips, and only
the back half of the pipeline was used: cut to numbered WebP, emit `config.js`, wire the canvas
engine. That half is identical either way, which is the point worth taking — `build-frames.mjs`
does not care where the footage came from, so if you already have clips you like, you can skip
straight to it.

Two things this hero does that the others do not:

**Per-moment pacing.** A flat scroll-to-frame mapping spends the same scroll on the most
interesting two seconds as on the least. The blink at frames 43 and 46 was six frames — about
77px of scroll, less than one wheel notch — and it was over before you registered it. A weight
table gives that range 3× the scroll and the push into the eye 1.8×, and lengthens the pin by
exactly the extra cost so nothing else speeds up to pay for it.

**Captions keyed to the footage, not to the scroll.** Once pacing makes those two diverge, a
caption placed at "44% of the scroll" no longer lands on the cut it was written for. Driving the
caption swap from the frame index instead keeps every line on its moment.

Both live in the site's `config.js` next to the frame count, so the copy and the pacing are
edited in one place rather than in the page.

## Piccs Pools

**246 frames · 87.5 MB · 364 KB/frame · 1920×1920**

Included deliberately as the cautionary example. Same six-stage pool build as Pools Pavers &
Patios, same frame count — and **three times the weight**.

The whole difference is generation-time choices: 1920×1920 square frames instead of 960×960.
Doubling each dimension quadruples the pixels, and WebP does not absorb that for free. 364 KB per
frame against PPP's 123 KB, for a hero that is displayed at the same size on the same screens.

Two specific mistakes, both cheap to avoid:

1. **Square at 1920.** Square framing forces a fit-by-height letterbox on any wide screen, so
   much of that resolution is cropped away before anyone sees it. Generate 16:9 —
   [American Floor Scraping](#american-floor-scraping) above is the same idea done that way, and
   lands at 84 KB/frame against this one's 364.
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
