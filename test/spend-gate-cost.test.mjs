/* The number printed above the y/n prompt, and the prompt itself.

   scripts/pricing.mjs can be perfectly correct and the gate still lie, because the gate's job is
   to hand it the right COUNT. Everything below is about that handoff, in both paid scripts, and
   the case it cares most about is `--only`.

   Why --only is the one worth standing on. An operator uses it after looking at the contact sheet:
   frame 4 came back wrong, so they re-run for frame 4. If the cost line quotes the whole
   storyboard, the number is roughly six times the truth. That is not a harmless over-statement -
   it is the number they will remember, so the next time they see the real figure they will read
   past it, and the one time it says something alarming they will read past that too. A cost line
   nobody reads is worse than no cost line, because it looks like a control.

   The same handoff has three other ways to go wrong, all covered here: a cached keyframe that
   will not be regenerated, a `--ref2` photo the operator supplied and nobody pays for, and a
   segment already on disk from a half-finished run.

   HOW THIS RUNS WITHOUT SPENDING. stageScript copies the real script into a temp directory next to
   a generated stub kie.mjs, so every paid entry point throws instead of calling kie.ai, and
   runScript strips KIE_API_KEY from the child so there is no credential in scope even if one got
   through. pricing.mjs is copied in beside it, which the other suites deliberately do not do -
   they exercise the degraded "no rate table" path; this one needs the real figures. SSH_RATES and
   SSH_RATES_FILE are blanked so a rate pinned on the developer's machine cannot reprice the
   assertions. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { confirm } from '../scripts/kie.mjs'
import { stageScript, runScript, write, storyboard, SCRIPTS, KIE_URL } from './helpers/harness.mjs'

/* Blank rather than absent: loadRates treats an empty string as unset, and passing them
   explicitly means a developer with SSH_RATES exported does not get different numbers. */
const ENV = { SSH_RATES: '', SSH_RATES_FILE: '' }

function stage (scriptName, stub) {
  const dir = stageScript(scriptName, stub)
  fs.copyFileSync(path.join(SCRIPTS, 'pricing.mjs'), path.join(dir, 'pricing.mjs'))
  return dir
}

const frames = (ids) => Object.fromEntries(ids.map(i =>
  [i, { file: `keyframe-0${i}.png`, url: `https://example.invalid/kf${i}.png` }]))

/* ---------- keyframes.mjs ---------- */

function keyframeRunner ({ steps = 6, cached = [], ref2 = false } = {}) {
  const dir = stage('keyframes.mjs')
  const outDir = path.join(dir, 'keyframes')
  const meta = { ref: 'ref.jpg', ...(ref2 ? { ref2: 'after.jpg' } : {}) }
  const sbFile = write(path.join(dir, 'storyboard.json'), { ...storyboard(steps), _meta: meta })
  write(path.join(outDir, '_state.json'), {
    refUrlRec: { url: 'https://example.invalid/ref.jpg', uploadedAt: Date.now() },
    frames: frames(cached),
  })
  return (...argv) => runScript(dir, 'keyframes.mjs',
    ['--storyboard', sbFile, '--out', outDir, ...argv], ENV)
}

test('keyframes: the cost line prices the stills that will actually be generated', async (t) => {
  /* Six 2K stills is 60 credits at kie.ai's quoted 10/image. Every case below is that same rate
     against a different count, and the count is the thing under test. */
  const cases = [
    ['the whole storyboard', {}, [], 6, '~60 credits (~$0.30)', '1, 2, 3, 4, 5, 6'],
    ['--only 2,4', {}, ['--only', '2,4'], 2, '~20 credits (~$0.10)', '2, 4'],
    ['--only 4 alone', {}, ['--only', '4'], 1, '~10 credits (~$0.05)', '4'],
    ['two frames already cached', { cached: [1, 2] }, [], 4, '~40 credits (~$0.20)', '3, 4, 5, 6'],
    ['a supplied --ref2 "after" photo', { ref2: true }, [], 5, '~50 credits (~$0.25)', '1, 2, 3, 4, 5'],
  ]

  for (const [label, opts, argv, count, cost, ids] of cases) {
    await t.test(label, () => {
      const r = keyframeRunner(opts)(...argv)

      assert.match(r.stdout, new RegExp(`^About to generate ${count} keyframe still\\(s\\)$`, 'm'), r.stdout)
      assert.match(r.stdout, new RegExp(`^ {2}keyframes {3}${ids.replace(/,/g, ',')}$`, 'm'),
        'the ids on the line have to be the ids being bought')
      assert.match(r.stdout, new RegExp(`^ {2}cost {8}${cost.replace(/[.$()~]/g, '\\$&')} `, 'm'), r.stdout)
      assert.match(r.stdout, new RegExp(`^ {14}${count} images? at 2K, 10 credits/image$`, 'm'),
        'and the basis has to show its own arithmetic')

      /* The specific lie: the whole-storyboard figure must not appear anywhere on a narrowed run. */
      if (count !== 6) {
        assert.doesNotMatch(r.stdout, /~60 credits|\$0\.30/,
          'a narrowed run must never quote the whole storyboard - that is the number people remember')
      }
    })
  }
})

test('keyframes: --only re-bills a cached frame, and the gate says so out loud', () => {
  /* The one case where the count is HIGHER than "images you do not have": --only regenerates
     whatever it names. Usually the intent, always worth a sentence, and it must still be in the
     price - a re-bill quoted at zero is the same class of defect as the whole-storyboard one. */
  const r = keyframeRunner({ cached: [1, 2, 3] })('--only', '2')

  assert.match(r.stdout, /^About to generate 1 keyframe still\(s\)$/m)
  assert.match(r.stdout, /^ {2}cost {8}~10 credits \(~\$0\.05\)/m, 'a re-bill is a bill')
  assert.match(r.stdout, /--only re-bills: keyframe 2 already on disk, so this pays for it again\./)
})

test('keyframes: the "after" photo the operator supplied is named as free, not silently dropped', () => {
  const r = keyframeRunner({ ref2: true })()
  assert.match(r.stdout, /Keyframe 6 is the finished photo you supplied: copied in, not generated, not billed\./)
  assert.match(r.stdout, /^ {2}cost {8}~50 credits \(~\$0\.25\)/m, 'five stills, not six')
})

/* ---------- tween.mjs ---------- */

function tweenRunner ({ steps = 6, onDisk = [] } = {}) {
  const dir = stage('tween.mjs')
  const kfDir = path.join(dir, 'keyframes')
  const outDir = path.join(dir, 'segments')
  const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(steps))
  write(path.join(kfDir, '_state.json'), { frames: frames(Array.from({ length: steps }, (_, i) => i + 1)) })
  fs.mkdirSync(outDir, { recursive: true })
  const segments = {}
  for (const id of onDisk) {
    const name = `segment-0${id}.mp4`
    fs.writeFileSync(path.join(outDir, name), 'not really an mp4')
    segments[id] = { from: id, to: id + 1, file: name }
  }
  write(path.join(outDir, '_state.json'), { segments })
  return (...argv) => runScript(dir, 'tween.mjs',
    ['--storyboard', sbFile, '--keyframes', kfDir, '--out', outDir, ...argv], ENV)
}

test('tween: the cost line prices the segments that will actually be rendered', async (t) => {
  /* Kling bills per SECOND, so the basis line has to show seconds and the total has to move with
     --duration as well as with the count. 18 credits/second at pro, 5s a segment. */
  const cases = [
    ['the whole storyboard', {}, [], 5, '~450 credits (~$2.25)', '5 segments x 5s at pro = 25s'],
    ['--only 3', {}, ['--only', '3'], 1, '~90 credits (~$0.45)', '1 segment x 5s at pro = 5s'],
    ['one segment already on disk', { onDisk: [1] }, [], 4, '~360 credits (~$1.80)', '4 segments x 5s at pro = 20s'],
    ['--duration 3', {}, ['--duration', '3'], 5, '~270 credits (~$1.35)', '5 segments x 3s at pro = 15s'],
    ['--mode std', {}, ['--mode', 'std'], 5, '~350 credits (~$1.75)', '5 segments x 5s at std = 25s'],
    ['--mode 4K', {}, ['--mode', '4K'], 5, '~1,675 credits (~$8.38)', '5 segments x 5s at 4K = 25s'],
  ]

  for (const [label, opts, argv, count, cost, basis] of cases) {
    await t.test(label, () => {
      const r = tweenRunner(opts)(...argv)

      assert.match(r.stdout, new RegExp(`^About to generate ${count} video segment\\(s\\)$`, 'm'), r.stdout)
      assert.match(r.stdout, new RegExp(`^ {2}cost {6}${cost.replace(/[.$()~,]/g, '\\$&')} `, 'm'), r.stdout)
      assert.ok(r.stdout.includes(basis), `the basis should read "${basis}":\n${r.stdout}`)

      if (!(count === 5 && cost.startsWith('~450'))) {
        assert.doesNotMatch(r.stdout, /~450 credits|\$2\.25/,
          'a narrowed or re-priced run must never quote the default whole-storyboard figure')
      }
    })
  }
})

test('tween: --mode 4K is the flag that changes the answer, and the gate prints the difference', () => {
  /* 3.7x on one word. This is the single most decision-changing number the gate has, and it went
     entirely unpriced before the rate table existed. */
  const pro = tweenRunner()().stdout
  const uhd = tweenRunner()('--mode', '4K').stdout
  assert.match(pro, /~450 credits \(~\$2\.25\)/)
  assert.match(uhd, /~1,675 credits \(~\$8\.38\)/)
  assert.match(uhd, /^ {2}mode {6}4K \(3840x2160 at 16:9\)$/m)
})

/* ---------- the gate itself ---------- */

test('both gates print a real figure, name its source, and never block on the balance', async (t) => {
  /* The four things that have to be on the screen before somebody can answer y/n, in both
     scripts: what it costs, how that was worked out, who says so, and whether the account covers
     it. The balance is looked up with no key in the child's environment, so it degrades - and the
     point of this assertion is that it degrades VISIBLY and the prompt still happens. */
  for (const [name, out] of [['keyframes.mjs', keyframeRunner()().stdout], ['tween.mjs', tweenRunner()().stdout]]) {
    await t.test(name, () => {
      assert.match(out, /<- an ESTIMATE, not a quote/, 'the figure must not be presented as a quote')
      assert.match(out, /confidence high, checked 2026-08-07/)
      assert.match(out, /source https:\/\/kie\.ai\//, 'a rate with no re-runnable source is decoration')
      assert.match(out, /account +balance unknown \(KIE_API_KEY is not set\)/,
        'an unavailable balance is stated, not omitted and not invented')
      assert.doesNotMatch(out, /NOT ENOUGH CREDIT/,
        'an unknown balance is not a shortfall - crying wolf here is how a real warning gets skipped')
      assert.match(out, /aborted - nothing generated, nothing charged/,
        'and the run still reached the prompt rather than hanging on the lookup')
    })
  }
})

test('without --yes and with no keyboard, both gates decline and print the exact re-run command', async (t) => {
  /* confirm()'s no-TTY branch. It must not hang, must not auto-approve, and must hand back a
     command that can be pasted - including whatever --only or --mode the operator had typed,
     because retyping it from memory is how the wrong run gets confirmed. */
  for (const [name, r, flag] of [
    ['keyframes.mjs', keyframeRunner()('--only', '2,4'), '--only 2,4'],
    ['tween.mjs', tweenRunner()('--mode', '4K'), '--mode 4K'],
  ]) {
    await t.test(name, () => {
      assert.equal(r.status, 1, `declining must be a non-zero exit:\n${r.out}`)
      assert.match(r.stdout, /aborted - nothing generated, nothing charged/)
      assert.match(r.stderr, /This step spends credits and needs confirmation, but stdin is not interactive/)
      assert.match(r.stderr, /Re-run with {2}--yes {2}to confirm you want to spend/)

      const suggested = r.stderr.split('\n').find(l => l.includes(name) && l.includes('--yes'))
      assert.ok(suggested, `no re-run command was printed:\n${r.stderr}`)
      assert.ok(suggested.trimEnd().endsWith('--yes'), `--yes must be appended: ${suggested}`)
      assert.ok(suggested.includes(flag), `the operator's own flags must survive: ${suggested}`)
      /* The cost is repeated on stderr next to the command, because that is the stream somebody
         reading a piped run will actually see the refusal on. */
      assert.match(r.stderr, /^ {2}cost/m)
    })
  }
})

test('--yes carries a run past the gate; without it nothing is even attempted', async (t) => {
  /* The positive control for the two tests above. A gate that refused everything would satisfy
     every "did not spend" assertion in this suite while making the pipeline unusable, and --yes
     is the only way an agent or CI can run this at all.

     This is the one place that replaces the harness's stub kie.mjs. The harness marks a paid entry
     point with the word BILLABLE, which runScript treats as a failed test - correct everywhere
     else, and useless here, because REACHING the paid call is the assertion. The replacement below
     re-exports the same real args/confirm/state, still makes no network call of any kind, and
     marks the paid entry points with a different word so the result can be read rather than
     thrown. The BILLABLE guard stays armed for every other test in this file. */
  const stub = `
import { args, confirm, state } from ${JSON.stringify(KIE_URL)}
export { args, confirm, state }
export function requireKey () { return 'test-key-that-is-never-sent-anywhere' }
export async function uploadFile () { return { url: 'https://example.invalid/u', uploadedAt: Date.now() } }
export async function freshUrl (rec) { return rec || { url: 'https://example.invalid/u', uploadedAt: Date.now() } }
export async function sol () { throw new Error('sol is not reached by this test') }
export async function createTask () { throw new Error('PAST-THE-GATE: createTask') }
export async function pollTask () { throw new Error('PAST-THE-GATE: pollTask') }
export async function download () { throw new Error('PAST-THE-GATE: download') }
`

  for (const [name, build] of [
    ['keyframes.mjs', () => {
      const dir = stage('keyframes.mjs')
      fs.writeFileSync(path.join(dir, 'kie.mjs'), stub)
      const outDir = path.join(dir, 'keyframes')
      const sbFile = write(path.join(dir, 'storyboard.json'), { ...storyboard(3), _meta: { ref: 'ref.jpg' } })
      write(path.join(outDir, '_state.json'), { refUrlRec: { url: 'https://example.invalid/r', uploadedAt: Date.now() }, frames: {} })
      return (...argv) => runScript(dir, 'keyframes.mjs', ['--storyboard', sbFile, '--out', outDir, ...argv], ENV)
    }],
    ['tween.mjs', () => {
      const dir = stage('tween.mjs')
      fs.writeFileSync(path.join(dir, 'kie.mjs'), stub)
      const kfDir = path.join(dir, 'keyframes')
      const sbFile = write(path.join(dir, 'storyboard.json'), storyboard(3))
      write(path.join(kfDir, '_state.json'), { frames: frames([1, 2, 3]) })
      return (...argv) => runScript(dir, 'tween.mjs',
        ['--storyboard', sbFile, '--keyframes', kfDir, '--out', path.join(dir, 'segments'), ...argv], ENV)
    }],
  ]) {
    await t.test(name, () => {
      const run = build()

      const declined = run()
      assert.doesNotMatch(declined.out, /PAST-THE-GATE/,
        'a run nobody confirmed must not reach a paid call, whatever else it does')
      assert.match(declined.stdout, /aborted - nothing generated, nothing charged/)

      const confirmed = run('--yes')
      assert.match(confirmed.out, /PAST-THE-GATE/,
        '--yes has to actually confirm, or nothing scripted can ever run this')
      assert.doesNotMatch(confirmed.stdout, /aborted - nothing generated, nothing charged/)
      assert.doesNotMatch(confirmed.stderr, /stdin is not interactive/,
        '--yes must short-circuit ahead of the TTY check, not after it')
      /* And it still shows the bill on the way past. --yes skips the question, not the disclosure. */
      assert.match(confirmed.stdout, /^ {2}cost/m)
    })
  }
})

test('confirm() with no TTY does not auto-approve, does not hang, and quotes the command', async () => {
  /* Driven in-process against the real function rather than only through a child, so the three
     properties are pinned individually. The TTY flag is forced false and never true: a true value
     would put a readline question on a stdin nothing is going to answer, which is a hung suite
     rather than a failed assertion. */
  const realIsTTY = process.stdin.isTTY
  const realArgv = process.argv
  const realError = console.error
  const errors = []

  const call = async (opts) => {
    errors.length = 0
    console.error = (...a) => errors.push(a.join(' '))
    process.stdin.isTTY = false
    process.argv = [process.execPath, 'C:\\scratch dir\\keyframes.mjs', '--only', '2,4']
    try {
      /* If confirm() ever blocks on a stdin nobody is typing at, this is what says so. */
      let timer
      const answered = await Promise.race([
        confirm('Generate these stills?', opts),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('confirm() did not answer within 3s')), 3000) }),
      ]).finally(() => clearTimeout(timer))
      return { answered, text: errors.join('\n') }
    } finally {
      console.error = realError
      process.stdin.isTTY = realIsTTY
      process.argv = realArgv
    }
  }

  const declined = await call({ yes: false, whatItCosts: '  cost  ~20 credits (~$0.10)' })
  assert.equal(declined.answered, false, 'an un-answerable prompt is a NO - never a yes by default')
  assert.match(declined.text, /stdin is not interactive/)
  assert.match(declined.text, /^ {2}cost {2}~20 credits \(~\$0\.10\)$/m,
    'the refusal has to repeat what it was about to spend')
  /* The command is the whole value of this branch: it is the difference between "it did not work"
     and one paste. Whitespace in the path has to survive as a quoted argument. */
  assert.match(declined.text, /"C:\\scratch dir\\keyframes\.mjs" --only 2,4 --yes/)

  const approved = await call({ yes: true, whatItCosts: '  cost  ~20 credits (~$0.10)' })
  assert.equal(approved.answered, true, '--yes must keep working for non-interactive and agent-driven runs')
  assert.equal(approved.text, '', '--yes is checked before the TTY branch, so nothing is printed')
})
