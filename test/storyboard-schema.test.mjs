/* MEDIUM-9. Sol's output is the one input in this pipeline nobody controls, and it is also the
   one input that has already been PAID FOR by the time anyone looks at it.

   Two things have to hold at once, and historically neither did:

     the raw response reaches the disk before anything is allowed to reject it. The old code only
     saved it inside the JSON.parse catch, so output that parsed but was structurally wrong died
     on a stack trace and took the billed response with it.

     a storyboard that does not match the schema is REFUSED. The case that did not throw - a
     steps/motions count mismatch - wrote cleanly, passed every consumer, and surfaced three
     stages later in build-frames as a chapter captioned from the wrong clip.

   Every case below runs the real storyboard.mjs against a canned Sol response. Nothing is
   uploaded and nothing is generated: the staged client returns the fixture and throws on any
   call that would spend. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard } from './helpers/harness.mjs'

/* Run storyboard.mjs with `solText` as everything Sol "said". Returns the result plus the two
   files that matter: the receipt and the storyboard itself. */
function ask (solText, { steps = 4, extra = [] } = {}) {
  const dir = stageScript('storyboard.mjs', { solText })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder - the staged client never reads it')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare yard to finished pool', '--steps', String(steps), '--out', out, ...extra])
  return {
    ...r,
    out,
    raw: out + '.raw.txt',
    wrote: fs.existsSync(out),
    receipt: fs.existsSync(out + '.raw.txt') ? fs.readFileSync(out + '.raw.txt', 'utf8') : null,
  }
}

/* Every rejection has to look the same from the outside: exit 1, no storyboard written, and the
   thing that was paid for still on disk, byte for byte. */
function assertRefused (r, match) {
  assert.equal(r.status, 1, `expected a refusal:\n${r.out}`)
  assert.match(r.stderr, match)
  assert.equal(r.wrote, false, 'a storyboard that failed validation must not be written')
  assert.notEqual(r.receipt, null, `the PAID response was discarded - it should be at ${r.raw}`)
  assert.match(r.stderr, /you paid for it, so it is not discarded|Raw output saved to/)
}

test('a well-formed storyboard is accepted and annotated', () => {
  const sb = storyboard(4)
  const r = ask(JSON.stringify(sb))

  assert.equal(r.status, 0, r.out)
  assert.equal(r.wrote, true)
  const written = JSON.parse(fs.readFileSync(r.out, 'utf8'))
  assert.equal(written.steps.length, 4)
  assert.equal(written.motions.length, 3)
  assert.equal(written._meta.idea, 'bare yard to finished pool')
  assert.match(written._meta.createdAt, /^\d{4}-\d\d-\d\dT/)

  /* The receipt is written on the happy path too, not only on failure. */
  assert.equal(r.receipt, JSON.stringify(sb))
})

test('a fenced response is recovered rather than failed', () => {
  /* Models fence JSON even when told not to. Paying again for a formatting habit is not a
     validation policy. */
  const sb = storyboard(4)
  const r = ask('```json\n' + JSON.stringify(sb, null, 2) + '\n```')
  assert.equal(r.status, 0, r.out)
  assert.equal(JSON.parse(fs.readFileSync(r.out, 'utf8')).steps.length, 4)
})

test('unparseable output keeps the receipt', () => {
  const r = ask('Sure! Here is your storyboard:\n\nStep 1: dig a hole.')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /did not return parseable JSON/)
  assert.equal(r.wrote, false)
  assert.equal(r.receipt, 'Sure! Here is your storyboard:\n\nStep 1: dig a hole.')
  assert.match(r.stderr, new RegExp('Raw output saved to'))
})

test('the receipt survives a structural refusal, not just a parse failure', () => {
  /* This is the regression that mattered. Valid JSON, wrong shape: it parses, so the old
     save-inside-the-catch never ran, and the paid response went in the bin. */
  const wrong = JSON.stringify({ subject: 's', camera: 'c', steps: [], motions: [] })
  const r = ask(wrong)
  assert.equal(r.receipt, wrong, 'the paid response must be on disk before validation runs')
})

test('missing steps is refused without crashing on undefined.length', () => {
  /* A missing `steps` used to make the motions check dereference undefined.length and die before
     the write - destroying the paid response on the way out. */
  const r = ask(JSON.stringify({ subject: 's', camera: 'c', motions: [] }))
  assertRefused(r, /steps must be a non-empty array \(got undefined\)/)
  assert.doesNotMatch(r.stderr, /TypeError|Cannot read/, 'it must refuse, not throw')
})

test('an empty steps array is refused', () => {
  const r = ask(JSON.stringify({ subject: 's', camera: 'c', steps: [], motions: [] }))
  assertRefused(r, /steps must be a non-empty array \(got an empty array\)/)
})

test('the wrong number of steps is refused', () => {
  const r = ask(JSON.stringify(storyboard(3)), { steps: 4 })
  assertRefused(r, /expected 4 steps, got 3/)
})

test('a steps/motions count mismatch is refused', () => {
  /* The one that did NOT throw, so it wrote cleanly and surfaced three stages later as a chapter
     captioned from the wrong clip. */
  const sb = storyboard(4)
  sb.motions.pop()
  const r = ask(JSON.stringify(sb))
  assertRefused(r, /expected 3 motions for 4 steps, got 2/)
})

test('duplicate step ids are refused', () => {
  /* keyframes.mjs keys its state by step.id: on a normal run the repeat prints "cached" and is
     never rendered even though the cost line promised it, and under --only both render and the
     second overwrites the first. Two different silent failures, both paid for. */
  const sb = storyboard(4)
  sb.steps[2].id = 2
  sb.motions = [{ from: 1, to: 2, prompt: 'p' }, { from: 2, to: 2, prompt: 'p' }, { from: 2, to: 4, prompt: 'p' }]
  const r = ask(JSON.stringify(sb))
  assertRefused(r, /step ids must be unique, got \[1, 2, 2, 4\]/)
})

test('step ids that do not run 1..n in order are refused', () => {
  /* keyframes.mjs reads st.frames[step.id - 1] for the continuity anchor AND takes the last array
     entry as the final frame, so both assumptions have to hold at once. */
  const sb = storyboard(4)
  sb.steps.forEach((s, i) => { s.id = i + 10 })
  sb.motions = [{ from: 10, to: 11, prompt: 'p' }, { from: 11, to: 12, prompt: 'p' }, { from: 12, to: 13, prompt: 'p' }]
  const r = ask(JSON.stringify(sb))
  assertRefused(r, /step ids must run 1\.\.4 in array order/)
})

test('a motion pointing at a step that does not exist is refused', () => {
  const sb = storyboard(4)
  sb.motions[1].to = 9
  const r = ask(JSON.stringify(sb))
  assertRefused(r, /motion #2 \(2 -> 9\) does not join two real step ids/)
})

test('duplicate motion "from" values are refused', () => {
  /* tween.mjs keys segment state by m.from, so a repeat bills a second Kling render and then
     overwrites the first - a paid video build-frames never emits a clip for. */
  const sb = storyboard(4)
  sb.motions[2].from = 2
  const r = ask(JSON.stringify(sb))
  assertRefused(r, /motion "from" values must be unique/)
})

test('empty text fields are refused, because the blank is what gets billed', () => {
  /* keyframePrompt is what gets rendered and paid for. Missing, it pays to draw the string
     "undefined" and the failure only shows up on the contact sheet. */
  const sb = storyboard(4)
  delete sb.steps[1].keyframePrompt
  sb.steps[2].label = '   '
  sb.motions[0].prompt = ''
  const r = ask(JSON.stringify(sb))
  assertRefused(r, /step 2 has no keyframePrompt/)
  assert.match(r.stderr, /step 3 has no label/)
  assert.match(r.stderr, /motion #1 \(1 -> 2\) has no prompt/)
})

test('every complaint is collected and reported at once', () => {
  /* Refusing on the first problem means the operator fixes one thing, re-runs, pays again, and
     finds the next one. */
  const r = ask(JSON.stringify({ subject: 's', camera: 'c', steps: [{ id: 1 }], motions: 'nope' }), { steps: 2 })
  assert.equal(r.status, 1)
  const complaints = r.stderr.split('\n').filter(l => l.trim().startsWith('- '))
  assert.ok(complaints.length >= 4, `expected several complaints at once, got:\n${r.stderr}`)
  assert.match(r.stderr, /expected 2 steps, got 1/)
  assert.match(r.stderr, /step 1 has no label/)
  assert.match(r.stderr, /step 1 has no keyframePrompt/)
  assert.match(r.stderr, /motions must be an array \(got string\)/)
})

test('a response that is not an object at all is refused', () => {
  for (const [text, why] of [['null', /parsed as null/], ['[1,2,3]', /parsed as an array/], ['"hi"', /parsed as string/]]) {
    const r = ask(text)
    assert.equal(r.status, 1, `${text} should be refused`)
    assert.match(r.stderr, why)
    assert.equal(r.receipt, text)
  }
})

test('--steps is validated before Sol is ever asked', () => {
  /* The validator above only runs after Sol has been billed, so the floor belongs up front:
     "exactly 1 steps and 0 motions" is a question worth not paying for. */
  for (const bad of ['1', '0', '-3']) {
    const dir = stageScript('storyboard.mjs', { solText: null })   /* sol() throws if reached */
    const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
    const r = runScript(dir, 'storyboard.mjs', ['--ref', ref, '--idea', 'x', '--steps', bad])
    assert.equal(r.status, 1, `--steps ${bad} should be refused`)
    assert.match(r.out, /--steps must be a whole number of 2 or more/)
  }
})

test('a non-string idea cannot reach the prompt', () => {
  /* The type-check that backs up the parser. `--idea --steps 6` once bound the boolean true, and
     kie.ai was paid to storyboard the literal string "Idea: true". The two ends stay independent
     on purpose: a validation guard that only works when its input is already correct is not a
     guard. */
  const dir = stageScript('storyboard.mjs', { solText: null })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const r = runScript(dir, 'storyboard.mjs', ['--ref', ref, '--idea', '--steps', '6'])
  assert.equal(r.status, 1)
  assert.match(r.out, /--idea needs a value/)
})
