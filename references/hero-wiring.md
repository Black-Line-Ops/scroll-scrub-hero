# Wiring the frames into a page

## Contents
- [The drop-in contract](#the-drop-in-contract)
- [Adding a hero to a page that has none](#adding-a-hero-to-a-page-that-has-none)
- [Gotchas that took real debugging](#gotchas-that-took-real-debugging)

## The drop-in contract

`build-frames.mjs` writes exactly this, and any page that already reads it needs no changes:

```
assets/hero-scroll/frames/
├── config.js
├── clip1/frame-0001.webp … frame-0040.webp
├── clip2/…
└── clipN/…
```

`config.js` sets two globals (the prefix is `--var`, default `HERO`):

```js
window.HERO_EXT="webp";
window.HERO_SEQ=[
  {"dir":"clip1","n":40,"k":"01 · Excavation","t":"We dig, frame, and reinforce for Florida soil."},
  …
];
```

`dir` is the folder, `n` the exact frame count, `k` a short kicker, `t` the caption. Frame files
are `frame-` plus a 4-digit 1-based index. `n` must match what's on disk exactly — the page
indexes by number, so a mismatch is a missing image mid-scrub.

Check before wiring anything new:

```bash
grep -n "HERO_SEQ\|hero-scroll/frames" <page>.html
```

## Adding a hero to a page that has none

Load the config before the engine, and GSAP + ScrollTrigger before both:

```html
<script src="assets/hero-scroll/frames/config.js"></script>
```

Markup — the tall scroller with a sticky viewport inside it:

```html
<section id="scrolly">
  <div class="sticky">
    <canvas id="heroCanvas"></canvas>
    <div class="hlede" id="hlede">
      <div class="hkick"><span id="capNum"></span> <span id="capStage"></span></div>
      <h1 id="capT">Scroll to build <em>your backyard.</em></h1>
      <p id="capSub"></p>
    </div>
  </div>
</section>
```

```css
#scrolly{position:relative; height:600vh}          /* scroll distance = how slow the scrub feels */
#scrolly .sticky{position:sticky; top:0; height:100vh; height:100dvh; overflow:hidden}
#heroCanvas{position:absolute; inset:0; width:100%; height:100%; display:block}
```

`height:600vh` is the tuning knob: more height, slower scrub. Roughly 2vh per frame feels
natural — 250 frames wants ~500–600vh.

The engine:

```js
const SEQ = window.HERO_SEQ || [], EXT = window.HERO_EXT || 'webp';
const BASE = 'assets/hero-scroll/frames/';

/* Flatten every clip into one list. HOLD0 repeats frame 1 so the intro headline has room
   before the build starts moving - without it the first scroll pixel already changes the
   image and the opening copy never gets read. */
const FLAT = [], HOLD0 = 37;
const F1 = `${BASE}${SEQ[0].dir}/frame-0001.${EXT}`;
for (let i = 0; i < HOLD0; i++) FLAT.push({ src: F1, ci: 0 });
SEQ.forEach((c, k) => { for (let j = 1; j <= c.n; j++)
  FLAT.push({ src: `${BASE}${c.dir}/frame-${String(j).padStart(4,'0')}.${EXT}`, ci: k }); });
const FRAMES = FLAT.length;

const cv = document.getElementById('heroCanvas'), cx = cv.getContext('2d');
const dpr = Math.min(2, devicePixelRatio || 1);
let lastImg = null, curF = 0, targetF = 0, scrollProg = 0;

function fit () {
  const r = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  cx.imageSmoothingQuality = 'high';
  if (lastImg) paint(lastImg);
}
/* cover-fit: fill the canvas, crop the overflow */
function paint (img) {
  if (!img || !img.complete || !img.naturalWidth) return;
  lastImg = img;
  const s = Math.max(cv.width / img.naturalWidth, cv.height / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  cx.drawImage(img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

const cache = new Map(), CACHE_MAX = 90;
function get (i) {
  if (i < 0 || i >= FRAMES) return null;
  let e = cache.get(i);
  if (e) { cache.delete(i); cache.set(i, e); return e; }        /* LRU touch */
  const im = new Image();
  e = { im, ready: false };
  const ok = () => { e.ready = true; if (i === Math.round(curF)) paint(im); };
  im.src = FLAT[i].src;
  (im.decode ? im.decode() : Promise.reject())
    .then(ok).catch(() => { im.complete ? ok() : (im.onload = ok, im.onerror = ok); });
  cache.set(i, e);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return e;
}
function drawFrame (i) {
  const e = get(i);
  if (e && e.ready) paint(e.im); else if (lastImg) paint(lastImg);
  for (let k = 1; k <= 6; k++) get(i + k);                       /* read ahead */
}

function tick () {
  curF += (targetF - curF) * 0.22;                               /* ease toward the target */
  if (Math.abs(targetF - curF) < 0.02) curF = targetF;
  drawFrame(Math.round(curF));
}

/* Preload a first batch, then start. Attaching load AND error unconditionally matters -
   see the background-tab gotcha below. */
const INIT = Math.min(44, FRAMES);
let rdy = 0, started = false;
for (let i = 0; i < INIT; i++) {
  const e = get(i); let counted = false;
  const bump = () => { if (counted) return; counted = true; if (++rdy === INIT) start(); };
  if (e.ready) bump();
  else { e.im.addEventListener('load', bump, { once: true });
         e.im.addEventListener('error', bump, { once: true });
         if (e.im.complete) bump();
         if (e.im.decode) e.im.decode().then(bump).catch(() => {}); }
}
setTimeout(() => { if (!started) start(); }, 12000);             /* never strand the user */

function start () {
  if (started) return; started = true;
  fit(); addEventListener('resize', fit); drawFrame(0);
  if (!window.gsap || !window.ScrollTrigger) { drawFrame(FRAMES - 1); return; }
  gsap.registerPlugin(ScrollTrigger);
  ScrollTrigger.create({
    trigger: '#scrolly', start: 'top top', end: 'bottom bottom',
    onUpdate: s => { scrollProg = s.progress; targetF = scrollProg * (FRAMES - 1); },
  });
  gsap.ticker.add(tick);
}
```

Captions, if you want them, key off `FLAT[i].ci` — the clip index each frame belongs to — and
read `SEQ[ci].k` / `SEQ[ci].t`. Swap them when `ci` changes rather than every frame.

## Gotchas that took real debugging

**`img.decode()` never settles in a background tab.** It neither resolves nor rejects, so a
`.catch()` fallback never fires either and the loader hangs forever on a backgrounded load.
Attach `load` and `error` listeners *unconditionally* and let them race `decode()`, with a
one-shot guard so the count stays honest. This is why the preload loop above looks redundant.

**Name collisions in a single shared script scope.** These pages tend to be one long inline
script. A second `function paint(...)` anywhere in the file silently replaces this one and the
canvas renders blank while every other check still passes. Grep for any name you introduce, and
when verifying, assert the canvas has *painted pixels* rather than that the element exists:

```js
const c = document.querySelector('#scrolly canvas'), g = c.getContext('2d');
const d = g.getImageData(0, 0, c.width, c.height).data;
const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 997) seen.add(d[i]+','+d[i+1]+','+d[i+2]);
seen.size > 20;   // a blank canvas samples 1-2 colours
```

**Temporal dead zone on a warm cache.** If frames are already cached, their decode callbacks run
*synchronously* inside the preload loop. Anything they touch that's declared with `let`/`const`
*below* the loop throws a ReferenceError, which aborts the loop and hangs the page — and only on
a warm cache, so it looks intermittent. Declare all loader state above the loop.

**`overflow-x: hidden` on `html`/`body` silently kills `position: sticky`.** The scrub simply
never pins, while `getComputedStyle` still reports `sticky`. Fix the overflow at whatever element
actually needs it (usually `min-width: 0` on a flex child, or parking an off-canvas nav
off-screen left) rather than clipping the root.

**CSS source order at equal specificity.** Long single-`<style>` pages accumulate duplicate
selectors. Before adding a rule, grep for other declarations of the same selector — and remember
media queries add no specificity, so a later top-level duplicate beats a rule inside an earlier
`@media`.
