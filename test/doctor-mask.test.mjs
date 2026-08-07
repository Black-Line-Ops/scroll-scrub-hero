/* doctor.mjs prints a masked KIE_API_KEY, and doctor output is the first thing anyone pastes
   into a bug report. The mask has one job - withhold characters - and the old one printed short
   keys IN FULL, because slice(0,4) and slice(-4) OVERLAP at eight characters or fewer.

   doctor.mjs cannot be imported: it is a top-level program and it makes four network probes on
   load, which this suite is not allowed to do. mask() is not exported either. So the test lifts
   the real declaration out of the real file and evaluates that one line. It is deliberately
   literal about where it looks - if the mask is ever rewritten into a shape this cannot find, the
   test fails asking to be re-pointed rather than quietly stopping checking. Exporting mask() from
   doctor.mjs would make all of this unnecessary; see the note in test/README.md. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SCRIPTS } from './helpers/harness.mjs'

const source = fs.readFileSync(path.join(SCRIPTS, 'doctor.mjs'), 'utf8')
const decl = source.match(/^const mask = .*$/m)

test('the mask declaration is where this test expects it', () => {
  assert.ok(decl, 'could not find `const mask = ...` on one line in scripts/doctor.mjs.\n' +
    'If the mask was refactored, re-point this test at it - do not delete it.')
})

/* eslint-disable-next-line no-new-func -- the point is to evaluate the SHIPPED expression, not a
   copy of it; a copy could agree with itself while both are wrong. */
const mask = decl ? new Function(`${decl[0]}; return mask`)() : null

test('a key short enough for the old mask to leak entirely is never printed', async (t) => {
  /* The specific regression: at eight characters or fewer the two slices overlap and the "mask"
     reproduced the whole key. */
  for (const len of [1, 2, 4, 7, 8]) {
    await t.test(`${len} characters`, () => {
      const key = 'k'.repeat(len - 1) + 'Z'
      const out = mask(key)
      assert.equal(out.includes(key), false, `mask() printed the whole ${len}-character key: ${out}`)
      assert.match(out, /truncated paste/,
        'anything that short is a bad paste rather than a live credential, and saying so is more useful')
    })
  }
})

test('a realistic key shows the first four characters and nothing else', () => {
  const key = 'sk-live-9f3a2b7c4d1e5f6a8b9c0d1e2f3a4b5c6d7e8f90'
  const out = mask(key)
  assert.equal(out, 'sk-l…')
  /* The tail is gone on purpose: the leading characters identify which key is loaded and expose a
     stray quote or space, which is the whole of what this line owes the user. */
  assert.equal(out.includes(key.slice(-4)), false, 'the tail must not be printed')
  assert.equal(out.includes(key.slice(4)), false)
})

test('no key of any length leaks more than four characters', () => {
  /* A property rather than a case list, because the failure mode was an off-by-one in a boundary
     nobody re-derived after changing the slice widths. */
  for (let len = 1; len <= 80; len++) {
    /* Distinct characters, so any surviving run of the key is findable rather than coincidental. */
    const key = Array.from({ length: len }, (_, i) => String.fromCharCode(33 + (i % 90))).join('')
    const out = mask(key)
    for (let start = 0; start < len; start++) {
      for (let n = 5; start + n <= len; n++) {
        assert.equal(out.includes(key.slice(start, start + n)), false,
          `mask() of a ${len}-character key leaked "${key.slice(start, start + n)}"`)
      }
    }
  }
})

test('the length is still reported, because a key one character short is otherwise invisible', () => {
  /* Not part of mask() itself - the call site owns it - so this asserts the call site instead. */
  assert.match(source, /ok\(`KIE_API_KEY is set \(\$\{mask\(k\)\}, \$\{k\.length\} chars\)`\)/,
    'doctor.mjs should print the masked key alongside its length')
})

test('nothing else in the scripts prints the key', () => {
  /* The cheapest possible guard against the mask being bypassed somewhere the reviewer was not
     looking. Reading the environment variable is fine, and so is putting it in an Authorization
     header; interpolating it into a line of OUTPUT is not. */
  for (const file of fs.readdirSync(SCRIPTS).filter(f => f.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(SCRIPTS, file), 'utf8')
    for (const [i, line] of text.split('\n').entries()) {
      /* ok/bad/note are doctor.mjs's own printers, so they count as output too. */
      if (!/console\.(log|warn|error)|process\.stdout\.write|^\s*(ok|bad|note)\(/.test(line)) continue
      assert.doesNotMatch(line, /process\.env\.KIE_API_KEY|Bearer \$\{/,
        `${file}:${i + 1} looks like it prints the key: ${line.trim()}`)
      /* `k` is doctor.mjs's name for the key itself, and ${mask(k)} is the only legitimate use. */
      if (file === 'doctor.mjs') {
        assert.doesNotMatch(line, /\$\{k\}/, `${file}:${i + 1} prints the unmasked key: ${line.trim()}`)
      }
    }
  }
})
