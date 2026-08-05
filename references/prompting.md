# Prompting for a first/last-frame chain

Most quality problems in this pipeline are prompt problems, not API problems. Read this before
writing or revising prompts by hand.

## The one rule everything descends from

The video model is given two fixed images and asked to invent the middle. It does that well when
the two images are *the same photograph at two moments* and badly when they are two different
photographs. When it decides they're too different, it stops interpolating and cuts — you get a
hard jump mid-hero, which is the one thing a scrub hero cannot survive.

So: **lock the camera, change the subject.** Every technique below is a way of enforcing that.

## Keyframe prompts

A keyframe prompt describes a scene **at rest**. It is the caption of a photograph, not a
description of an action. If a keyframe prompt contains a verb of motion, the image model will
try to depict motion blur or an in-progress action, and the two endpoints of the tween will
disagree about where things are.

Weak — describes action and moves the camera:
> Drone sweeps over the yard as the excavator digs out the pool shape

Strong — describes a state, camera fixed:
> The same backyard from the same fixed camera. A rectangular excavation now occupies the centre
> of the lawn, roughly four feet deep, with clean vertical walls and a mound of removed soil
> piled at the left edge. The house, fence, palms and neighbouring rooftops are unchanged.

Three things that prompt does:
1. Says "same … same fixed camera" explicitly. Repetition works.
2. Describes only the changed region in detail.
3. Names the things that must NOT change. Listing them is what stops the model redecorating the
   house while it digs the hole.

`keyframes.mjs` appends the camera line and the "keep the real location" anchor automatically,
so a hand-written prompt only needs the scene description.

## Motion prompts

A motion prompt describes **one physical process** carrying the scene from state A to state B.
It is animated, so verbs belong here — but only one process.

Weak — a list, so the model rushes and morphs:
> The pool is dug, steel is tied, plumbing installed, then gunite sprayed and tile set

Strong — one process, concrete:
> An excavator digs the pool shape out of the lawn. Soil lifts away in stages and piles at the
> left. The hole deepens steadily to its finished depth. Camera locked, no pan or zoom.

Keep them under 500 characters — Kling rejects longer in single-shot mode, and `tween.mjs`
truncates rather than letting the call fail.

Ending with "camera locked, no pan or zoom" is worth the characters. The model otherwise adds
gentle drift, which reads as instability once frames are scrubbed under user control.

## Sequencing

**Six to eight keyframes.** Fewer and each tween carries too much change (cuts). More and the
sequence gets expensive and the story dilutes.

**Even change per gap.** If step 2→3 is a huge visual leap and 3→4 is trivial, the hero feels
lurchy. Rebalance the storyboard rather than fixing it downstream.

**Same time of day throughout.** Light direction is the fastest way to make two frames read as
different days. If the story genuinely spans months, keep the light constant anyway — viewers
read it as continuity, not as a documentary error.

**Nothing enters or leaves except the subject.** A car in the driveway in step 2 and gone in
step 3 will either cut or produce a car melting into the pavement.

## When a seam still cuts

In order of what to try:

1. **Regenerate the later keyframe from the earlier one**, with the earlier one's contents spelled
   out in the prompt. Most cuts are one frame disagreeing about something structural.
2. **Split the gap.** Insert an intermediate keyframe so each tween carries half the change. This
   fixes almost everything the first step doesn't, at the cost of one more segment.
3. **Shorten the duration.** A 3 s tween across the same gap gives the model less room to wander
   than a 10 s one. Fewer source frames, but you only need ~40.
4. **Simplify the motion prompt** to the single most important process and let the rest happen
   implicitly.

## When the subject drifts over the whole sequence

Drift is compounding error from chaining. The fix is to re-anchor: regenerate the offending
keyframe from the **original photo alone**, with an explicit written description of the state it
should be in, rather than from its neighbour. You trade a little continuity for a hard reset
back to the real property.

If drift is systemic rather than one frame, the reference photo may be doing too little work —
a tight crop of a lawn gives the model very little to hold onto. A wider shot with buildings,
fences and a horizon anchors far better.

## Adapting to other subjects

The pattern generalises beyond construction. What matters is that there's a fixed vantage and a
subject that changes state:

- **Interiors** — empty room → furnished. Anchor on windows, floor, ceiling lines.
- **Manufacturing** — raw stock → finished part. Anchor on the machine bed and lighting.
- **Restoration** — worn → restored. Anchor on the surroundings, change only the object.
- **Landscaping / renovation** — the same before/after logic as pools.

What does *not* fit: anything where the camera should travel through space. A first/last-frame
chain has no way to hold a moving camera coherent across a seam, so that needs a different
technique — a continuously rendered camera path rather than stitched tweens.
