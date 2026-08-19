/* build-frames.mjs WRITES config.js. references/hero-wiring.md is the only thing that READS it.
   Nothing in this repo connects them, and v1.2.0 proved what that costs.

   `--float` shipped emitting `window.<VAR>_ALPHA=true` into config.js. The reference engine had
   never heard of it, and its paint loop is a bare `drawImage` with no `clearRect` — correct and
   fast for opaque frames, because each one completely covers the last. Transparent frames cover
   nothing they do not draw, so every previous frame stayed underneath and the subject dragged a
   trail of its own history across the hero. The producer was right, the files were right, and the
   documented consumer rendered them wrong.

   It got through because test/float.test.mjs asserted that the ALPHA line reached config.js — the
   "assert the parts exist, not the output" pattern test/README.md forbids, and there was no output
   to assert because no consumer existed.

   This test is the seam itself: every global the producer can emit has to be named by the
   consumer. It cannot check that the page renders correctly - that needs a browser - but it makes
   shipping a global nothing understands impossible, which is the failure that actually happened. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SCRIPTS } from './helpers/harness.mjs'

const producer = fs.readFileSync(path.join(SCRIPTS, 'build-frames.mjs'), 'utf8')
const wiring = fs.readFileSync(path.join(ROOT, 'references', 'hero-wiring.md'), 'utf8')

/* Read the emitted names out of the producer rather than listing them here. A hardcoded list is
   another copy to forget: the next global would be added to build-frames.mjs, not to this array,
   and the test would pass while the gap it exists to find opened up again. */
function emittedGlobals (src) {
  const names = new Set()
  for (const m of src.matchAll(/window\.\$\{prefix\}(_[A-Z][A-Z0-9_]*)/g)) names.add(m[1])
  return [...names].sort()
}

test('build-frames.mjs emits the globals this test knows how to find', () => {
  const found = emittedGlobals(producer)
  /* A sanity check on the extractor, not on the docs. If this drops to nothing, the interpolation
     style changed and every assertion below would pass vacuously. */
  assert.ok(found.length >= 3, `expected at least 3 config globals, found ${JSON.stringify(found)}`)
  assert.ok(found.includes('_SEQ'), 'the frame list is the whole point of config.js')
})

test('every config.js global the producer can emit is documented for the page that reads it', () => {
  for (const g of emittedGlobals(producer)) {
    assert.ok(wiring.includes(`HERO${g}`),
      `build-frames.mjs writes window.<VAR>${g} and references/hero-wiring.md never mentions it. ` +
      'A page wired from that document will ignore it - which is exactly how --float shipped ' +
      'producing correct files that the documented engine rendered wrong.')
  }
})

test('the reference engine clears the canvas when the frames carry alpha', () => {
  /* The specific defect, asserted specifically. Documenting HERO_ALPHA is necessary and not
     sufficient: a page that reads the flag and does nothing with it still smears. */
  assert.match(wiring, /clearRect/,
    'hero-wiring.md never clears the canvas, so --float frames composite over their predecessors')
  const paint = wiring.slice(wiring.indexOf('function paint'), wiring.indexOf('function paint') + 900)
  assert.match(paint, /clearRect/, 'the clear has to be in paint(), not merely somewhere in the file')
  assert.match(paint, /ALPHA/, 'the clear must be conditional on the flag, or every opaque build pays for it')
})

test('hero-wiring does not still claim config.js sets exactly two globals', () => {
  /* The sentence that was true in 1.1.0 and quietly false from 1.2.0 onward. Counting in prose is
     a claim like any other, and this one sat directly above the list it was miscounting. */
  assert.equal(/sets two globals/.test(wiring), false,
    'hero-wiring.md still says "two globals" while build-frames.mjs emits more')
})
