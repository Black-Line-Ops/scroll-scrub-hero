/* tween.mjs's confirm gate approves roughly 88% of what a run costs - five 5s pro segments are
   ~$2.25 of a ~$2.55 total, against ~$0.30 for the six stills before them. It is therefore the one
   prompt in the pipeline where a savings hint is worth the space, and the one place it can do real
   damage if it is wrong.

   Three ways it could be wrong, and one assertion each:

     Quoting a saving that is not real. Every figure is computed by pricing.mjs for THIS segment
     count rather than copied from a table in a comment, so the test checks the arithmetic against
     pricing.mjs directly rather than against a hardcoded string.

     Offering the setting you already chose. A list padded with non-options, or with a saving of
     $0.00, is noise at exactly the moment attention is worth most.

     Quietly undoing a deliberate decision. SKILL.md keeps --duration out of the interview on
     purpose: shortening a segment is ALSO the first cheap repair when a seam cuts, so a run that
     starts at the floor has nothing left to give. Printing the saving without that sentence would
     reverse that decision by omission, which is why the caveat is asserted as hard as the price. */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { stageScript, runScript, write, storyboard } from './helpers/harness.mjs'

/* A run that has keyframes on disk and no segments yet - the state the gate is written for. */
function gate (argv = [], { steps = 6 } = {}) {
  const dir = stageScript('tween.mjs', { also: ['pricing.mjs'] })
  const sb = storyboard(steps)
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const kfDir = path.join(dir, 'keyframes')
  const frames = {}
  for (const s of sb.steps) {
    const file = path.join(kfDir, `keyframe-0${s.id}.png`)
    write(file, 'placeholder')
    frames[s.id] = { file, url: 'https://example.invalid/uploads/fake/kf' + s.id, uploadedAt: Date.now() }
  }
  write(path.join(kfDir, '_state.json'), { frames })
  const r = runScript(dir, 'tween.mjs',
    ['--storyboard', sbFile, '--keyframes', kfDir, '--out', path.join(dir, 'segments'), '--dry-run', ...argv])
  return { ...r, segments: sb.motions.length }
}

test('the gate offers the cheaper configurations of the same run', () => {
  const r = gate()

  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /Cheaper ways to order this same run/)
  assert.match(r.stdout, /--mode std\s+~\d+ credits/)
  assert.match(r.stdout, /--duration 3\s+~\d+ credits/)
  assert.match(r.stdout, /--mode std --duration 3\s+~\d+ credits/)
  /* The point of putting it here rather than in the docs: backing out is free, and the reason
     people do not change a setting at a y/n prompt is that they assume it is not. */
  assert.match(r.stdout, /Nothing has been generated yet/)
})

test('every quoted saving matches what pricing.mjs actually computes', async () => {
  const r = gate()
  const pricing = await import('../scripts/pricing.mjs')

  const base = pricing.estimateTween({ segments: r.segments, seconds: 5, mode: 'pro' })
  const cases = [
    ['--mode std', { segments: r.segments, seconds: 5, mode: 'std' }],
    ['--duration 3', { segments: r.segments, seconds: 3, mode: 'pro' }],
    ['--mode std --duration 3', { segments: r.segments, seconds: 3, mode: 'std' }],
  ]
  for (const [flag, opts] of cases) {
    const alt = pricing.estimateTween(opts)
    const expected = (base.usd.low - alt.usd.low).toFixed(2)
    /* Anchored to the flag so a saving cannot be validated against the wrong row - the failure
       that would look right in a screenshot and be wrong on the invoice. */
    const line = r.stdout.split('\n').find(l => l.includes(flag + ' ') || l.trimEnd().endsWith(flag))
    assert.ok(line, `no line for ${flag}`)
    assert.ok(line.includes(`save ~$${expected}`),
      `${flag}: expected "save ~$${expected}", got: ${line.trim()}`)
    /* And the price beside it, not just the difference. */
    assert.ok(line.includes(`~$${alt.usd.low.toFixed(2)}`),
      `${flag}: expected the run price ~$${alt.usd.low.toFixed(2)}, got: ${line.trim()}`)
  }
})

test('the --duration hint carries the reason 5s is the default', () => {
  const r = gate()

  /* Without this the block silently reverses a decision SKILL.md made on purpose. A cheaper number
     with no caveat is a recommendation, whatever the surrounding prose says. */
  assert.match(r.stdout, /5s is deliberate/)
  assert.match(r.stdout, /first cheap fix when a seam cuts/)
  /* It also has to say that 3s still yields enough frames, or the saving looks like it costs
     smoothness, which it does not. */
  assert.match(r.stdout, /frames a segment, well above the \d+ kept/)
})

test('nothing is offered when nothing is cheaper', () => {
  const r = gate(['--mode', 'std', '--duration', '3'])

  assert.equal(r.status, 0, r.out)
  assert.equal(r.stdout.includes('Cheaper ways'), false,
    'the cheapest configuration was offered ways to get cheaper')
  assert.equal(r.stdout.includes('save ~$0.00'), false, 'a saving of nothing is not an option')
})

test('a partly-cheaper configuration offers only what is actually cheaper', () => {
  const r = gate(['--mode', 'std'])

  assert.equal(r.status, 0, r.out)
  assert.match(r.stdout, /Cheaper ways/)
  /* Already at std, so std must not be offered back - but the duration lever is still open. */
  assert.match(r.stdout, /--duration 3\s+~\d+ credits/)
  assert.equal(/^\s+--mode std\s+~/m.test(r.stdout), false, 'offered the mode already selected')
})

test('the list survives pricing.mjs being absent, by not appearing', () => {
  /* The sandbox has no pricing.mjs unless a test stages one, which is the real deployment where a
     partial install has lost it. A gate that printed an empty heading, or worse invented figures,
     would be the defect this repo is audited for. */
  const dir = stageScript('tween.mjs')
  const sb = storyboard(4)
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const kfDir = path.join(dir, 'keyframes')
  const frames = {}
  for (const s of sb.steps) {
    const file = path.join(kfDir, `keyframe-0${s.id}.png`)
    write(file, 'placeholder')
    frames[s.id] = { file, url: 'https://example.invalid/uploads/fake/kf' + s.id, uploadedAt: Date.now() }
  }
  write(path.join(kfDir, '_state.json'), { frames })
  const r = runScript(dir, 'tween.mjs',
    ['--storyboard', sbFile, '--keyframes', kfDir, '--out', path.join(dir, 'segments'), '--dry-run'])

  assert.equal(r.status, 0, r.out)
  assert.equal(r.stdout.includes('Cheaper ways'), false)
  assert.equal(r.stdout.includes('save ~$'), false, 'a figure was quoted with no rate table to quote from')
})
