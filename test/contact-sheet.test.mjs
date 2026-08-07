/* The contact sheet is the human approval gate: a person opens it in a browser and decides
   whether to authorise the expensive Kling stage. Every string on it comes from somewhere
   untrusted - the subject, camera, labels and captions are Sol's description of a photo a client
   emailed in, and the image filename is whatever the operator typed after --ref2.

   Two of the six sinks are the ones a naive escaping test misses:

     <title> is RCDATA. It has no elements inside it, so a payload containing </title> ends the
     element early and everything after it lands in <head> and runs BEFORE the page renders -
     which would let an injection rewrite the one human check standing in front of the spend.

     The --ref2 filename reaches an HTML attribute. `after.jpg" onerror="alert(1)` breaks out of
     src="..." even when the model output is completely clean, so escaping the model's strings
     alone does not close this.

   keyframes.mjs is a top-level program, so this drives the real script end to end with every
   keyframe already cached - the path that writes the sheet and exits without generating anything.
   No image is rendered and nothing is billed; the stub client throws if anything tries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stageScript, runScript, write, tmpDir, storyboard } from './helpers/harness.mjs'

/* One payload per sink, each carrying a unique token so a survivor can be traced back to the
   interpolation that let it through. Every one of them is a real break-out for its context. */
const HOSTILE = {
  subject: '</title><script>alert("SINK_SUBJECT")</script><b foo="',
  camera: '"><script>alert("SINK_CAMERA")</script>',
  label: '<img src=x onerror=alert("SINK_LABEL")>',
  caption: '</figcaption></figure><script>alert("SINK_CAPTION")</script>',
  filename: 'after.jpg" onerror="alert(\'SINK_FILENAME\')',
  /* Not attacker-controlled in practice, but it is interpolated the same way and costs nothing
     to prove. A step id is whatever was in the JSON, and the JSON came from a model. */
  id: '3"><script>alert("SINK_ID")</script>',
}

/* The complete set of tags keyframes.mjs writes, each stripped of its quoted attributes. Escaping
   turns every payload's angle brackets into entities, so a correctly escaped document can only
   contain the tags the script itself wrote - which makes an allowlist over the whole tag stream a
   far stronger assertion than grepping for "<script".

   Stripping the attribute VALUES first is the step that separates this from a naive test, and
   getting it wrong fails on CORRECT output: an escaped `<img src=x onerror=alert(1)>` caption
   legitimately still reads ` onerror=` - as inert text, inside a quoted value. What matters is
   only what survived OUTSIDE the quotes, so that is what gets checked. */
const ALLOWED_TAG = /^<\/?(?:!doctype html|meta|title|style|h1|p|div|figure|figcaption|img|span|b|code|br)>$/i

function assertInert (html, where) {
  for (const tag of html.match(/<[^>]*>/g) || []) {
    /* A quoted value cannot contain a raw " once escaped, so this consumes exactly the real
       attributes and leaves anything that broke out of one behind for the allowlist to reject. */
    const skeleton = tag.replace(/\s+[a-zA-Z-]+="[^"]*"/g, '')
    assert.match(skeleton, ALLOWED_TAG,
      `${where}: an element that is not part of the sheet, or an attribute that broke out -> ${tag}`)
    assert.doesNotMatch(skeleton, /\son\w+/i, `${where}: an inline event handler survived -> ${tag}`)
  }
  /* Redundant given the allowlist, but it names the failure in one word when it happens. */
  assert.doesNotMatch(html, /<script/i, `${where}: a <script> tag survived`)
  /* RCDATA: exactly one <title> opened and exactly one closed. A payload containing </title> ends
     the element early, and everything after it becomes live markup in <head> - the case that runs
     before the page renders, and the reason escaping the body alone is not enough. */
  assert.equal((html.match(/<title>/gi) || []).length, 1, `${where}: expected exactly one <title>`)
  assert.equal((html.match(/<\/title>/gi) || []).length, 1, `${where}: a payload closed <title> early`)
  /* <style> is the other raw-text element on the page and fails the same way. */
  assert.equal((html.match(/<\/style>/gi) || []).length, 1, `${where}: a payload closed <style> early`)
  /* Every image tag has to be exactly the shape the script writes, and its src has to be a bare
     relative filename. If a --ref2 name broke out of the src attribute this is where it shows,
     whatever it then went on to do. */
  for (const img of html.match(/<img[^>]*>/g) || []) {
    const m = img.match(/^<img src="([^"'<>]*)" alt="">$/)
    assert.ok(m, `${where}: malformed <img> -> ${img}`)
    assert.doesNotMatch(m[1], /^[a-z][a-z0-9+.-]*:/i, `${where}: the frame src carries a scheme -> ${m[1]}`)
  }
}

function stage (sb, frames, extraMeta = {}) {
  const dir = stageScript('keyframes.mjs')
  const outDir = path.join(dir, 'keyframes')
  const sbFile = write(path.join(dir, 'storyboard.json'),
    { ...sb, _meta: { ref: 'ref.jpg', ...extraMeta } })
  write(path.join(outDir, '_state.json'), {
    refUrlRec: { url: 'https://example.invalid/ref.jpg', uploadedAt: Date.now() },
    frames,
  })
  return { dir, outDir, sbFile }
}

test('hostile storyboard text cannot execute in the contact sheet', () => {
  const sb = storyboard(3)
  sb.subject = HOSTILE.subject
  sb.camera = HOSTILE.camera
  sb.steps[0].label = HOSTILE.label
  sb.steps[0].caption = HOSTILE.caption
  sb.steps[1].id = HOSTILE.id            /* a non-integer id, exactly as a bad model might emit */

  const { dir, outDir, sbFile } = stage(sb, {
    1: { file: '/tmp/keyframe-01.png' },
    /* The --ref2 filename break-out. Recorded in state rather than created on disk because a
       Windows filename may not contain a double quote - the sink is the same either way, since
       writeSheet() only ever takes path.basename() of this value. */
    [HOSTILE.id]: { file: `/tmp/${HOSTILE.filename}` },
    3: { file: '/tmp/keyframe-03.png' },
  })

  const r = runScript(dir, 'keyframes.mjs', ['--storyboard', sbFile, '--out', outDir])
  assert.equal(r.status, 0, `expected the all-cached path to exit 0:\n${r.out}`)
  assert.match(r.stdout, /nothing to generate/)

  const html = fs.readFileSync(path.join(outDir, 'contact-sheet.html'), 'utf8')
  assertInert(html, 'contact sheet')

  /* Not one of the payloads survives in raw form anywhere in the document. */
  for (const [sink, payload] of Object.entries(HOSTILE)) {
    assert.equal(html.includes(payload), false, `the raw ${sink} payload is present in the output`)
  }

  /* ...but all of them are still THERE, escaped. Escaping that silently drops the text would
     pass every check above and quietly destroy the artifact. */
  for (const token of ['SINK_SUBJECT', 'SINK_CAMERA', 'SINK_LABEL', 'SINK_CAPTION', 'SINK_FILENAME', 'SINK_ID']) {
    assert.ok(html.includes(token), `${token} was dropped instead of escaped`)
  }
  assert.ok(html.includes('&lt;script&gt;'), 'the script tags should appear as escaped text')
  assert.ok(html.includes('&quot;'), 'the attribute-breaking quotes should appear escaped')

  /* Per-sink placement, so a regression names the sink rather than just "somewhere". */
  const title = html.match(/<title>([\s\S]*?)<\/title>/)[1]
  assert.ok(title.includes('SINK_SUBJECT'), 'the subject should reach <title>')
  assert.doesNotMatch(title, /[<>]/, '<title> is RCDATA - it must contain no raw angle brackets')

  assert.ok(html.includes('Camera: &quot;&gt;&lt;script&gt;'), 'the camera line should reach p.sub, escaped')

  const imgs = html.match(/<img[^>]*>/g) || []
  assert.equal(imgs.length, 3, 'one image per cached keyframe')
  const hostileImg = imgs.find(t => t.includes('SINK_FILENAME'))
  assert.ok(hostileImg, 'the --ref2 filename should still reach the sheet, escaped')
  assert.equal(hostileImg,
    '<img src="after.jpg&quot; onerror=&quot;alert(&#39;SINK_FILENAME&#39;)" alt="">',
    `the filename broke out of the src attribute: ${hostileImg}`)

  /* Belt and braces behind esc(): a sink someone forgets to wrap later has to degrade to mangled
     text rather than code, and nothing on this page may reach the network. */
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)
  assert.ok(csp, 'the contact sheet must carry a CSP meta tag')
  assert.match(csp[1], /default-src 'none'/, 'the CSP must deny by default')
  assert.doesNotMatch(csp[1], /script-src/, 'nothing should re-permit script')
  assert.match(csp[1], /img-src[^;]*'self'/, 'local frames still have to load, or the artifact is worthless')
})

test('an ampersand-heavy caption survives as readable text', () => {
  /* The other direction: escaping must not corrupt ordinary copy. Sol writes captions like
     "Excavation & shell" all the time. */
  const sb = storyboard(2)
  sb.steps[0].caption = 'Excavation & shell — 5" of base, then the "big" pour'
  const { dir, outDir, sbFile } = stage(sb, { 1: { file: '/tmp/a.png' }, 2: { file: '/tmp/b.png' } })

  const r = runScript(dir, 'keyframes.mjs', ['--storyboard', sbFile, '--out', outDir])
  assert.equal(r.status, 0, r.out)

  const html = fs.readFileSync(path.join(outDir, 'contact-sheet.html'), 'utf8')
  assert.ok(html.includes('Excavation &amp; shell — 5&quot; of base'), 'ordinary punctuation should escape, not vanish')
  assert.equal(html.includes('&amp;amp;'), false, 'the escaper must not double-escape')
})

test('a --ref2 filename cannot carry markup onto the sheet through the copied file', (t) => {
  /* The other half of the filename defence: keyframes.mjs whitelists the extension when it copies
     the supplied "after" photo in, so the name that reaches the sheet is one this script chose.
     path.extname() returns everything after the last dot - quotes, brackets and all - so trusting
     it is what put attacker text in an attribute in the first place. */
  const src = path.join(tmpDir('ssh-ref2-'), "after.jpg'onload='alert(1)")
  try {
    fs.writeFileSync(src, 'not really an image, and nothing downstream reads the type off the name')
  } catch (e) {
    /* Some filesystems refuse the name outright, which is a perfectly good outcome - just not one
       this test can assert against. */
    t.skip(`this filesystem will not create the hostile filename (${e.code})`)
    return
  }

  const sb = storyboard(3)
  const { dir, outDir, sbFile } = stage(sb,
    { 1: { file: '/tmp/keyframe-01.png' }, 2: { file: '/tmp/keyframe-02.png' } },
    { ref2: src })

  const r = runScript(dir, 'keyframes.mjs', ['--storyboard', sbFile, '--out', outDir])
  assert.equal(r.status, 0, `expected the supplied-after-photo path to exit 0:\n${r.out}`)

  /* Whitelisted down to .jpg, because .jpg'onload='alert(1) is not a known extension. */
  assert.ok(fs.existsSync(path.join(outDir, 'keyframe-03.jpg')),
    `expected the copy to be renamed to keyframe-03.jpg; got ${fs.readdirSync(outDir).join(', ')}`)

  const html = fs.readFileSync(path.join(outDir, 'contact-sheet.html'), 'utf8')
  assertInert(html, 'contact sheet with a hostile --ref2 name')
  assert.equal(html.includes("onload='alert(1)"), false, 'the hostile filename reached the sheet')
  assert.match(html, /<img src="keyframe-03\.jpg"/, 'the sheet should point at the renamed copy')
})

test('a known extension is preserved rather than blindly rewritten', () => {
  const src = path.join(tmpDir('ssh-ref2-'), 'finished.WEBP')
  fs.writeFileSync(src, 'placeholder bytes')

  const sb = storyboard(3)
  const { dir, outDir, sbFile } = stage(sb,
    { 1: { file: '/tmp/keyframe-01.png' }, 2: { file: '/tmp/keyframe-02.png' } },
    { ref2: src })

  const r = runScript(dir, 'keyframes.mjs', ['--storyboard', sbFile, '--out', outDir])
  assert.equal(r.status, 0, r.out)
  assert.ok(fs.existsSync(path.join(outDir, 'keyframe-03.webp')),
    `expected keyframe-03.webp; got ${fs.readdirSync(outDir).join(', ')}`)
})
