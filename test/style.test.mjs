/* --style is an interview answer, and an interview answer that changes nothing is worse than a
   question never asked: it costs the user a decision and buys them nothing.

   The specific way this feature fails silently is worth stating, because it is what these
   assertions are shaped around. Sol is TOLD to repeat the art direction into every keyframePrompt.
   It mostly does. The frame it forgets is a frame that comes back looking like a different company,
   in a chain whose entire premise is that consecutive frames look like the same place - and the
   only way to find out is the contact sheet, after every still has been paid for.

   So the style is not merely handed to Sol. It is promoted to a top-level `sb.style` written from
   the FLAG rather than from anything the model returned, and keyframes.mjs appends it to every
   prompt it sends, exactly as it already does with the camera line. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, storyboard } from './helpers/harness.mjs'

const STYLE = 'shot on Portra 400, muted greens, no lens flare'

test('--style reaches Sol and is recorded on the storyboard, not only in the reply', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare yard to pool', '--steps', '4', '--out', out, '--style', STYLE])

  assert.equal(r.status, 0, r.out)
  const sent = JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'sol-call.json'), 'utf8')))
  assert.match(sent, /ART DIRECTION/)
  assert.equal(sent.includes(STYLE), true, 'the user\'s own words must reach the prompt verbatim')

  const sb = JSON.parse(fs.readFileSync(out, 'utf8'))
  /* Written from the flag, so it is right even when the fixture (like this one) is a storyboard
     that never mentioned the style at all - which is precisely the model behaviour being guarded
     against. */
  assert.equal(sb.style, STYLE)
  assert.equal(sb._meta.style, STYLE)
})

test('the seed frame is drawn under the same art direction as everything after it', () => {
  const dir = stageScript('storyboard.mjs', {
    solText: [JSON.stringify({ seedPrompt: 'A bare corner lot, chain-link fence.', camera: 'kerbside 35mm' }),
      JSON.stringify(storyboard(4))],
    image: 'png bytes',
  })
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--idea', 'empty lot to finished house', '--steps', '4', '--out', out, '--style', STYLE])

  assert.equal(r.status, 0, r.out)
  /* The seed is keyframe 1. If it is drawn in a house style and everything after it is drawn in
     the requested one, the very first thing the visitor sees is the one frame that is off-brand. */
  const calls = JSON.parse(fs.readFileSync(path.join(dir, 'sol-calls.json'), 'utf8'))
  assert.equal(JSON.stringify(calls[0]).includes(STYLE), true, 'the seed description ignored --style')
})

test('with no --style, nothing about the prompts changes', () => {
  const dir = stageScript('storyboard.mjs', { solText: JSON.stringify(storyboard(4)) })
  const ref = write(path.join(dir, 'yard.jpg'), 'placeholder')
  const out = path.join(dir, 'storyboard.json')
  const r = runScript(dir, 'storyboard.mjs',
    ['--ref', ref, '--idea', 'bare yard to pool', '--steps', '4', '--out', out])

  assert.equal(r.status, 0, r.out)
  const sent = fs.readFileSync(path.join(dir, 'sol-call.json'), 'utf8')
  assert.equal(sent.includes('ART DIRECTION'), false, 'an empty style must not leave a dangling heading')
  const sb = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal('style' in sb, false, 'no style asked for, no style key')
  assert.equal(sb._meta.style, null)
})

test('keyframes.mjs appends the style to every prompt it sends, not just the first', () => {
  const dir = stageScript('keyframes.mjs', { also: ['pricing.mjs'] })
  const sb = storyboard(4)
  sb.style = STYLE
  /* Deliberately NOT written into any keyframePrompt. This is the storyboard Sol actually returns
     when it forgets the instruction, and the whole point is that it no longer matters. */
  sb._meta = { ref: write(path.join(dir, 'yard.jpg'), 'placeholder'), seeded: false }
  const sbFile = write(path.join(dir, 'storyboard.json'), sb)
  const r = runScript(dir, 'keyframes.mjs',
    ['--storyboard', sbFile, '--out', path.join(dir, 'keyframes'), '--yes', '--dry-run'])

  assert.equal(r.status, 0, r.out)
  const shown = r.stdout.match(/ART DIRECTION \(identical in every frame\)/g) || []
  assert.equal(shown.length, sb.steps.length,
    `every one of the ${sb.steps.length} prompts should carry it, saw ${shown.length}`)
})
