/* The argument parser stands directly in front of every paid call in this skill, and four of the
   audit's defects were parser defects: `--idea --steps 6` bound the boolean true to idea and paid
   to storyboard the string "Idea: true"; an unquoted multi-word --idea paid to storyboard the
   first word; `--steps` with no value became NaN and asked for "exactly NaN steps"; `--budget-mb`
   became NaN, and `mb > NaN` is false for every mb, so the page-weight guard reported PASS while
   switched off.

   None of those are subtle once anyone looks. That is the point of this file: it is the cheapest
   test in the repo and it covers the place the expensive mistakes actually happened. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { args } from '../scripts/kie.mjs'
import { trapExit } from './helpers/harness.mjs'

/* args() reports rejections with console.error + process.exit(1). These two turn that into
   something assertable without spawning a process per case. */
const parse = (argv, opts) => trapExit(() => args(argv, opts))
const accepted = (argv, opts) => {
  const r = parse(argv, opts)
  assert.equal(r.exited, false, `expected [${argv.join(' ')}] to be accepted, but it exited: ${r.text}`)
  return r
}
const rejected = (argv, match, opts) => {
  const r = parse(argv, opts)
  assert.equal(r.exited, true, `expected [${argv.join(' ')}] to be REJECTED, got ${JSON.stringify(r.value)}`)
  assert.equal(r.code, 1, 'a rejected argv must exit 1')
  assert.match(r.text, match)
  return r
}

test('both flag forms are accepted', async (t) => {
  await t.test('--flag value', () => {
    assert.equal(accepted(['--mode', 'std']).value.mode, 'std')
  })

  /* The original bug: only the space form was supported, so --mode=std was silently dropped and
     the run billed at the pro default. */
  await t.test('--flag=value', () => {
    assert.equal(accepted(['--mode=std']).value.mode, 'std')
  })

  await t.test('--flag=value keeps everything after the first =', () => {
    assert.equal(accepted(['--idea=before=after']).value.idea, 'before=after')
  })

  await t.test('an empty --flag= is kept as an empty string, not dropped', () => {
    const v = accepted(['--prompt=']).value
    assert.equal(v.prompt, '')
    assert.ok('prompt' in v)
  })

  await t.test('values are left as strings for the call sites that parseInt them', () => {
    assert.strictEqual(accepted(['--steps', '6']).value.steps, '6')
  })

  await t.test('the returned object has a null prototype, so --constructor cannot shadow', () => {
    const v = accepted(['--constructor=x']).value
    assert.equal(Object.getPrototypeOf(v), null)
    assert.equal(v.constructor, 'x')
  })
})

test('a flag-shaped value is a missing value, not a value', async (t) => {
  /* The exact argv that paid to storyboard "Idea: true". */
  await t.test('--idea --steps 6 is rejected', () => {
    const r = rejected(['--idea', '--steps', '6'], /--idea needs a value/)
    assert.match(r.text, /--steps/, 'the message should name the flag it mistook for a value')
  })

  await t.test('a trailing flag with no value at all is rejected', () => {
    rejected(['--idea'], /--idea needs a value/)
  })

  await t.test('the boolean flags are still allowed to carry nothing', () => {
    assert.equal(accepted(['--yes']).value.yes, true)
    assert.equal(accepted(['--help']).value.help, true)
  })

  /* build-frames.mjs declares --allow-gaps this way rather than editing the shared table. If the
     extension point breaks, --allow-gaps at the end of argv becomes "needs a value" and the
     bring-your-own-clips path dies. */
  await t.test('a script can declare its own value-less flag', () => {
    const v = accepted(['--segments', 'segs/', '--allow-gaps'], { booleans: ['allow-gaps'] }).value
    assert.equal(v['allow-gaps'], true)
    assert.equal(v.segments, 'segs/')
  })
})

test('--yes=false is not consent', async (t) => {
  /* !!'false' is true, and this flag is the spend gate. */
  for (const no of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
    await t.test(`--yes=${no} means no`, () => {
      assert.equal(accepted([`--yes=${no}`]).value.yes, false)
    })
  }
  for (const go of ['true', '1', 'yes']) {
    await t.test(`--yes=${go} means yes`, () => {
      assert.equal(accepted([`--yes=${go}`]).value.yes, true)
    })
  }
})

test('numeric flags never become NaN', async (t) => {
  const NUMERIC = ['steps', 'duration', 'width', 'per-clip', 'quality', 'budget-mb']

  for (const flag of NUMERIC) {
    await t.test(`--${flag} with no value is rejected rather than parsed to NaN`, () => {
      rejected([`--${flag}`], new RegExp(`--${flag} needs a value`))
    })
    await t.test(`--${flag}= with an empty value is rejected`, () => {
      rejected([`--${flag}=`], new RegExp(`--${flag} must be a number`))
    })
    await t.test(`--${flag} with a non-number is rejected`, () => {
      rejected([`--${flag}`, 'six'], new RegExp(`--${flag} must be a number, got "six"`))
    })
  }

  await t.test('whitespace is not a number', () => {
    rejected(['--steps=   '], /--steps must be a number/)
  })

  await t.test('real numbers still get through, including decimals and negatives', () => {
    assert.equal(accepted(['--budget-mb', '35.5']).value['budget-mb'], '35.5')
    assert.equal(accepted(['--duration', '5']).value.duration, '5')
    /* Not the parser's job to bound them - only to guarantee downstream parseInt/parseFloat
       cannot silently produce NaN. Range belongs next to each sink. */
    assert.equal(accepted(['--width', '-1']).value.width, '-1')
  })

  await t.test('Infinity is not a usable frame count', () => {
    rejected(['--per-clip', 'Infinity'], /must be a number/)
    rejected(['--steps', 'NaN'], /must be a number/)
  })

  await t.test('a script can declare its own numeric flag', () => {
    rejected(['--fps', 'fast'], /--fps must be a number/, { numbers: ['fps'] })
    assert.equal(accepted(['--fps', '24'], { numbers: ['fps'] }).value.fps, '24')
  })
})

test('--only cannot silently filter to nothing', async (t) => {
  /* keyframes.mjs and tween.mjs do `only.includes(s.id)`. A --only that parses to [NaN] matches
     no step, so every stage is skipped, nothing is generated, and the run reports success having
     done nothing - the worst shape of failure in a resumable pipeline, because the next step then
     bills against a half-built state. */
  await t.test('--only with no value is rejected', () => {
    rejected(['--only'], /--only needs a value/)
  })

  await t.test('--only= empty is rejected', () => {
    rejected(['--only='], /--only takes step numbers/)
  })

  for (const junk of ['abc', '3,', ',3', '3,,5', '3;5', '1-3', '3.5', ' ']) {
    await t.test(`--only "${junk}" is rejected`, () => {
      rejected(['--only', junk], /--only takes step numbers/)
    })
  }

  await t.test('the documented forms are accepted', () => {
    assert.equal(accepted(['--only', '3']).value.only, '3')
    assert.equal(accepted(['--only', '3,5']).value.only, '3,5')
    assert.equal(accepted(['--only', '3, 5']).value.only, '3, 5')
  })

  await t.test('an accepted --only always parses to real step numbers', () => {
    /* Mirrors the call sites exactly: `a.only.split(',').map(s => parseInt(s.trim(), 10))`. */
    for (const v of ['3', '3,5', '3, 5', '10,2,7']) {
      const ids = v.split(',').map(s => parseInt(s.trim(), 10))
      assert.ok(ids.length > 0 && ids.every(Number.isInteger), `--only ${v} parsed to ${ids}`)
    }
  })
})

test('--var must be a JavaScript identifier', async (t) => {
  /* It is interpolated into generated source as window.<var>_SEQ. The realistic mistake is not an
     attack, it is `--var hero-scroll` - which emits `window.hero-scroll_SEQ=[`, throws at load
     time on the live page, and lets build-frames print its success summary and exit 0. */
  for (const bad of ['hero-scroll', '1HERO', 'my var', 'a.b', 'HERO;alert(1)', 'HERO)', '']) {
    await t.test(`--var "${bad}" is rejected`, () => {
      rejected([`--var=${bad}`], /--var must be a JavaScript identifier/)
    })
  }

  for (const good of ['HERO', 'hero', '_hero', '$hero', 'hero2', 'H_2$x']) {
    await t.test(`--var "${good}" is accepted`, () => {
      assert.equal(accepted(['--var', good]).value.var, good)
    })
  }
})

test('an unquoted multi-word value is detected, not truncated', async (t) => {
  /* The PowerShell mistake. `--idea bare yard to finished pool` used to bind "bare" and pay for
     it; the remaining words vanished without a word. */
  await t.test('the stray words are an error', () => {
    const r = rejected(['--idea', 'bare', 'yard', 'to', 'pool'], /unexpected argument "yard"/)
    assert.match(r.text, /must be quoted/, 'the message has to say what to do about it')
    assert.match(r.text, /--idea "/, 'and show the quoted form')
  })

  await t.test('a bare word before any flag is an error too', () => {
    rejected(['storyboard.json', '--steps', '6'], /unexpected argument "storyboard.json"/)
  })

  await t.test('a properly quoted multi-word value is untouched', () => {
    assert.equal(accepted(['--idea', 'bare yard to finished pool']).value.idea, 'bare yard to finished pool')
  })

  await t.test('a value that merely starts with a dash is fine', () => {
    assert.equal(accepted(['--idea', '-40C cold store fitout']).value.idea, '-40C cold store fitout')
  })
})

test('malformed flag names are rejected', async (t) => {
  for (const bad of ['---steps', '--2fast', '--=x', '--']) {
    await t.test(`"${bad}" is not a flag name`, () => {
      rejected([bad, 'x'], /is not a valid flag name|unexpected argument/)
    })
  }
})

test('a repeated flag warns but never drops a value in silence', () => {
  const r = accepted(['--steps', '4', '--steps', '6'])
  assert.equal(r.value.steps, '6', 'last flag wins, as every other CLI does')
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /--steps was given more than once; using the last value \("6"\)/)
})
