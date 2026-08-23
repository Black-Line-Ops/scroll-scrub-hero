/* Upload names carry a content hash, because the host OVERWRITES by filename.

   Proven the expensive way in the sibling scroll-flight (2026-08-22): three concurrent runs
   each uploaded a "scene-01.png", all three recorded the SAME URL
   (tempfile.redpandaai.co/kieai/<account>/images/scene-01.png), and a clip in one world
   rendered pinned to a frame from another world. The upload host keys files by account +
   filename and silently overwrites - a recorded URL is a mutable pointer, not a blob.

   The contract that makes one account safe for concurrent runs:
     SAME bytes      -> SAME name      (an overwrite is a no-op by definition)
     DIFFERENT bytes -> DIFFERENT name (cannot collide)
   A raw basename satisfies neither half. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REAL_FETCH = globalThis.fetch
const REAL_KEY = process.env.KIE_API_KEY

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 0x22)])

test('same bytes -> same name; different bytes under one basename -> different names', async (t) => {
  process.env.KIE_API_KEY = 'kie-test-0123456789abcdef'   /* never sent anywhere real */
  const names = []
  globalThis.fetch = async (url, opts) => {
    names.push(JSON.parse(opts.body).fileName)
    return new Response(JSON.stringify({ code: 200, msg: 'success', data: { fileUrl: 'https://file.kie.ai/uploads/x.png' } }), { status: 200 })
  }
  t.after(() => {
    globalThis.fetch = REAL_FETCH
    if (REAL_KEY === undefined) delete process.env.KIE_API_KEY
    else process.env.KIE_API_KEY = REAL_KEY
  })

  const { uploadFile } = await import('../scripts/kie.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-name-'))
  fs.mkdirSync(path.join(dir, 'run2'))
  const a1 = path.join(dir, 'scene-01.png')
  const a2 = path.join(dir, 'run2', 'scene-01.png')          /* same basename... */
  fs.writeFileSync(a1, PNG)
  fs.writeFileSync(a2, Buffer.concat([PNG, Buffer.from([0])])) /* ...different bytes */

  await uploadFile(a1)
  await uploadFile(a1)
  await uploadFile(a2)

  assert.equal(names.length, 3)
  assert.notEqual(names[0], 'scene-01.png', 'a raw basename is exactly the collision')
  assert.match(names[0], /^[0-9a-f]{10}-scene-01\.png$/)
  assert.equal(names[0], names[1], 'same bytes must map to the same name - a re-upload is a no-op')
  assert.notEqual(names[0], names[2],
    'different bytes under one basename is THE collision; the names must differ')
})
