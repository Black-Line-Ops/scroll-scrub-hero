/* The seed path: `--idea` with no `--ref`.

   Everything downstream of storyboard.mjs is built around one assumption - keyframe 1 is a file on
   disk, named in `_meta.ref` - and the whole design of this feature is to keep that true rather
   than to teach five more scripts about a second mode. So most of what is worth asserting here is
   about SAMENESS: the seeded run has to hand the rest of the pipeline exactly what a photographed
   run hands it, plus enough metadata to know which one happened.

   The rest is about not spending money by accident. Two of these cases are refusals, and for both
   the interesting assertion is not the exit code - it is that Sol was never asked, because a
   mistyped photo path that costs a Sol call and an image credit before it fails is a worse bug
   than one that fails loudly and free. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard } from './helpers/harness.mjs'

/* A seeded run needs two staged Sol answers in order: the opening frame, then the storyboard. */
const SEED_REPLY = JSON.stringify({
  seedPrompt: 'A bare suburban corner lot photographed from the kerb on a 35mm lens at chest height, ' +
    'chain-link fence, two mature oaks, a neighbouring beige bungalow to the left, overcast midday light.',
  camera: 'Chest height from the kerb, 35mm, square to the frontage',
})

function seededRun ({ sol = [SEED_REPLY, JSON.stringify(storyboard(4))], steps = 4, extra = [], ref = null, also = [] } = {}) {
  const dir = stageScript('storyboard.mjs', { solText: sol, image: 'png bytes', also })
  const out = path.join(dir, 'storyboard.json')
  const argv = ['--idea', 'empty lot to finished house', '--steps', String(steps), '--out', out, ...extra]
  if (ref !== null) argv.unshift('--ref', ref)
  const r = runScript(dir, 'storyboard.mjs', argv)
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null)
  return {
    ...r,
    out,
    seedFile: out.replace(/\.json$/i, '') + '.seed.png',
    meta: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8'))._meta : null,
    solCalls: read('sol-calls.json'),
    imageCalls: read('image-calls.json'),
  }
}

test('with no --ref, the opening frame is generated and becomes keyframe 1', () => {
  const r = seededRun()

  assert.equal(r.status, 0, r.out)
  assert.equal(r.imageCalls?.length, 1, 'exactly one image should be bought here - the seed')
  assert.equal(r.imageCalls[0].model, 'gpt-image-2-text-to-image')
  assert.equal(fs.existsSync(r.seedFile), true, 'the paid frame must reach the disk')

  /* The load-bearing assertion. keyframes.mjs opens _meta.ref as a file; if the seed is recorded
     as a URL, or not recorded at all, the next stage dies with "reference photo not found" and the
     seed that was just paid for is orphaned on disk. */
  assert.equal(r.meta.ref, r.seedFile)
  assert.equal(r.meta.seeded, true)
  assert.match(r.meta.seedPrompt, /chain-link fence/)
})

test('the seed is described before it is drawn, and the storyboard is written against it', () => {
  const r = seededRun()

  assert.equal(r.solCalls?.length, 2, 'the seed description and the storyboard are separate calls')
  /* Order is the point. Asking for the storyboard first would produce keyframe prompts written
     against a scene that does not exist yet, which is the failure this two-call shape prevents. */
  const first = JSON.stringify(r.solCalls[0])
  const second = JSON.stringify(r.solCalls[1])
  assert.match(first, /single photographic image prompt/, 'call 1 should be the seed description')
  assert.match(second, /storyboards for scroll-scrubbed website heroes/, 'call 2 should be the storyboard')
  /* And the storyboard call must actually carry the rendered frame, or Sol is writing blind. */
  assert.match(second, /input_image/)
  assert.match(second, /generated a moment ago/, 'a generated frame must not be described to Sol as a photograph')
})

test('--aspect and --resolution reach the render rather than only the forecast', () => {
  const r = seededRun({ extra: ['--aspect', '9:16', '--resolution', '4K'] })

  assert.equal(r.status, 0, r.out)
  assert.equal(r.imageCalls[0].input.aspect_ratio, '9:16')
  assert.equal(r.imageCalls[0].input.resolution, '4K')
  /* Recorded as well as used: keyframes.mjs defaults its own aspect from this, and a portrait run
     that silently reverts to 16:9 at step 2 pans and crops every tween in the chain. */
  assert.equal(r.meta.aspect, '9:16')
  assert.equal(r.meta.resolution, '4K')
})

test('a supplied photo still takes the old path, and buys no image', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder - the staged client never reads it')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs', ['--ref', ref, '--idea', 'bare yard to pool', '--steps', '4', '--out', out])

  assert.equal(r.status, 0, r.out)
  const meta = JSON.parse(fs.readFileSync(out, 'utf8'))._meta
  assert.equal(meta.ref, ref)
  assert.equal(meta.seeded, false)
  assert.equal(meta.seedPrompt, null)
  /* The stub throws on any paid image call, so reaching exit 0 is itself the proof that the photo
     path never wandered into the renderer. Stated anyway, because that is what is being claimed. */
  assert.equal(fs.existsSync(path.join(dir, 'image-calls.json')), false)
  assert.equal(fs.existsSync(out.replace(/\.json$/i, '') + '.seed.png'), false)
})

test('--ref with no value is a mistake, not a request to seed', () => {
  const dir = stageScript('storyboard.mjs', { solText: [SEED_REPLY, JSON.stringify(storyboard(4))], image: 'png' })
  const out = path.join(dir, 'storyboard.json')

  /* Both orderings, because they fail in different places: kie.mjs's parser catches the flag-follows-
     flag form, and a trailing --ref runs off the end of argv. Neither may be read as "no photo
     supplied, please invent one" - that is the same keystroke asking for opposite things. */
  for (const argv of [
    ['--ref', '--idea', 'empty lot to finished house', '--out', out],
    ['--idea', 'empty lot to finished house', '--out', out, '--ref'],
  ]) {
    const r = runScript(dir, 'storyboard.mjs', argv)
    assert.equal(r.status, 1, r.out)
    assert.match(r.stderr, /--ref needs a (value|file path)/)
    assert.equal(fs.existsSync(path.join(dir, 'sol-call.json')), false, 'nothing should be billed for a typo')
    assert.equal(fs.existsSync(path.join(dir, 'image-calls.json')), false)
  }
})

test('a --ref that does not exist fails as a missing file, before anything is billed', () => {
  const dir = stageScript('storyboard.mjs', { solText: [SEED_REPLY, JSON.stringify(storyboard(4))], image: 'png' })
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', path.join(dir, 'not-here.jpg'), '--idea', 'empty lot to finished house', '--out', out])

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /reference photo not found/)
  /* The specific bad outcome this guards: falling through to the seed path and generating a house
     for somebody who has one and mistyped its path. */
  assert.equal(fs.existsSync(path.join(dir, 'image-calls.json')), false)
})

test('an unparseable seed description is used as prose rather than thrown away', () => {
  const plain = 'A bare corner lot on an overcast morning, chain-link fence, two oaks, kerbside 35mm.'
  const r = seededRun({ sol: [plain, JSON.stringify(storyboard(4))] })

  assert.equal(r.status, 0, r.out)
  /* It is still a description of the scene, and it has already been paid for. Refusing over
     punctuation would throw away a billed call and send the user back to re-run the same prompt. */
  assert.equal(r.imageCalls[0].input.prompt.includes('chain-link fence'), true)
  assert.equal(r.meta.seeded, true)
})

test('an empty seed description stops the run instead of rendering nothing', () => {
  const r = seededRun({ sol: ['   ', JSON.stringify(storyboard(4))] })

  assert.equal(r.status, 1, r.out)
  assert.match(r.stderr, /returned nothing for the seed frame/)
  /* The refusal has to come BEFORE the render. An empty prompt still costs an image credit and
     comes back as whatever the model felt like drawing. */
  assert.equal(fs.existsSync(path.join(r.dir, 'image-calls.json')), false)
})

test('the seed is quoted in the forecast as money spent here, not money still to approve', () => {
  const r = seededRun({ also: ['pricing.mjs'] })

  assert.match(r.stdout, /^\s+seed\s+~\d+ credits/m, 'the seed needs its own line in the breakdown')
  assert.match(r.stdout, /seed and storyboard lines are being spent now/)
  /* The double-count this prevents: a seed left under kind "keyframes" appears once in the total
     and again in the "still to approve" line, for a still nobody is going to order. */
  const tail = r.stdout.slice(r.stdout.indexOf('Still to approve'))
  assert.equal(tail.includes('seed'), false, 'the seed is already bought - it cannot also be pending')
})
