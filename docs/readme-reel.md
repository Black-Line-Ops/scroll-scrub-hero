# The README reel: why it is a GIF

Maintenance notes for the animation at the top of `README.md`. This lived as a 22-line HTML
comment above the `<h1>` until it was moved here; the README now carries a three-line pointer at
the `<img>` instead. Read this before "upgrading" the reel to a video — that upgrade has already
been made and reverted once (`69011b2` switched GIF → MP4, `b7ce8d6` switched it back).

## Autoplay and scrub controls cannot both happen on GitHub

Both verified against the rendered README, not assumed:

- GitHub strips `autoplay`, `loop` and `playsinline` from author markup. Only `controls` and
  `muted` survive.
- GitHub's own uploaded-video player carries `controls muted` and **no** autoplay — read straight
  off `oso95/scroll-world`'s rendered README, which is the reference everyone points at. Its video
  does not autoplay either; you click it.
- A `<video>` tag pointing at a file in the repo is stripped outright. Verified with
  `GET /repos/{owner}/{repo}/readme`, `Accept: application/vnd.github.html` — zero `<video>`
  elements in the response.

That last check is the one to repeat if you want to re-test this, and the one that is easy to get
wrong: the `/markdown` API *keeps* the `<video>` when called **without** `context`, which makes it
a misleading way to test.

So an animated image is the only thing that plays by itself, and that is what the README ships.

## If you would rather have the player

Accepting click-to-play: drag `docs/examples-reel.mp4` into any GitHub comment box, copy the
`https://github.com/user-attachments/assets/...` URL it returns, and paste it bare on its own line
in place of the `<img>`.

## Why `width="100%"` on a 600px source

Deliberate, not an oversight. GIF costs ~500 KB per second at this width, so a natively-880px
version of the full 22 s run is 9–11 MB. The 600px source upscales cleanly enough — the headlines
stay crisp, only the small body copy softens — and the crisp original is one click away in the
MP4.
