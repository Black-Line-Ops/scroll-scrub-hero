/* The ffmpeg flag that decides whether step 4 of 4 runs at all.

   FFmpeg 9.0 (August 2026) removed `-vsync`; `-fps_mode` replaces it but only exists from 5.1.
   build-frames.mjs hard-coded `-vsync 0`, so on any ffmpeg 9 that DOES carry libwebp (gyan.dev
   on Windows, ffmpeg-full on Homebrew) the doctor's encoder-listing check passed and the frame
   build then aborted after the storyboard, every keyframe and every tween had been paid for.
   Found first in the sibling scroll-flight by an outside review, then confirmed there by CI on a
   real ffmpeg 9; ported here because this repo has been public the whole time.

   Pinned: the flag is chosen from the ffmpeg version, in ffmpeg-flags.mjs, and picks the OLD flag
   for 4.x (Ubuntu 22.04's apt still ships 4.4 - a bare swap to -fps_mode would have traded one
   broken population for another); build-frames.mjs reaches the encode ONLY through that helper;
   and doctor.mjs proves the encode by running it, on top of the listing check the
   encoder-column suite already pins. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir, ffmpegStatus, ROOT, SCRIPTS } from './helpers/harness.mjs'
import { parseFfmpegVersion, passthroughArgs, webpEncodeArgs, ffmpegVersion, trialEncode } from '../scripts/ffmpeg-flags.mjs'

const FF = ffmpegStatus()
const NEEDS_FF = { skip: FF.ok ? false : `ffmpeg unavailable: ${FF.why}` }

test('the version banners of every vintage we care about parse', () => {
  const cases = [
    ['ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers', 9, 0],
    ['ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers', 8, 1],
    ['ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers', 7, 1],
    ['ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers', 6, 1],
    ['ffmpeg version 5.1.2 Copyright (c) 2000-2022 the FFmpeg developers', 5, 1],
    ['ffmpeg version 5.0.1 Copyright (c) 2000-2022 the FFmpeg developers', 5, 0],
    ['ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers', 4, 4],
    ['ffmpeg version n7.1 Copyright (c) 2000-2024 the FFmpeg developers', 7, 1],
  ]
  for (const [line, major, minor] of cases) {
    const v = parseFfmpegVersion(line)
    assert.ok(v, `did not parse: ${line}`)
    assert.equal(v.major, major, line)
    assert.equal(v.minor, minor, line)
  }
  assert.equal(parseFfmpegVersion('ffmpeg version N-112345-gabcdef0 Copyright (c) 2000-2026'), null)
  assert.equal(parseFfmpegVersion(''), null)
})

test('the passthrough flag follows the version: -vsync below 5.1, -fps_mode from 5.1 up', () => {
  const old = ['-vsync', '0']
  const modern = ['-fps_mode', 'passthrough']
  assert.deepEqual(passthroughArgs({ major: 4, minor: 4 }), old, 'Ubuntu 22.04 apt')
  assert.deepEqual(passthroughArgs({ major: 5, minor: 0 }), old, '5.0 predates -fps_mode')
  assert.deepEqual(passthroughArgs({ major: 5, minor: 1 }), modern, '5.1 introduced -fps_mode')
  assert.deepEqual(passthroughArgs({ major: 8, minor: 1 }), modern)
  assert.deepEqual(passthroughArgs({ major: 9, minor: 0 }), modern, 'ffmpeg 9 removed -vsync entirely')
  assert.deepEqual(passthroughArgs(null), modern, 'unparsed reads as modern - every 4.x banner parses')
})

test('the encode arg list is the flag plus the exact libwebp settings build-frames always used', () => {
  assert.deepEqual(webpEncodeArgs(72, { major: 9, minor: 0 }),
    ['-fps_mode', 'passthrough', '-c:v', 'libwebp', '-quality', '72', '-preset', 'picture'])
  assert.deepEqual(webpEncodeArgs(78, { major: 4, minor: 4 }),
    ['-vsync', '0', '-c:v', 'libwebp', '-quality', '78', '-preset', 'picture'])
})

test('build-frames.mjs reaches the encode only through the helper - no literal -vsync anywhere', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'build-frames.mjs'), 'utf8')
  assert.doesNotMatch(src, /'-vsync'/, 'a hard-coded -vsync is exactly the ffmpeg-9 failure')
  assert.doesNotMatch(src, /'-fps_mode'/, 'a hard-coded -fps_mode breaks every 4.x user instead')
  assert.match(src, /\.\.\.webpEncodeArgs\(quality\)/)
  assert.match(src, /import \{ webpEncodeArgs \} from '\.\/ffmpeg-flags\.mjs'/)
})

test('doctor.mjs proves the encode by running it, on top of the listing check', () => {
  const src = fs.readFileSync(path.join(SCRIPTS, 'doctor.mjs'), 'utf8')
  assert.match(src, /import \{[^}]*\btrialEncode\b[^}]*\} from '\.\/ffmpeg-flags\.mjs'/)
  assert.match(src, /trialEncode\(probeDir\)/)
  /* the listing check stays - encoder-column.test.mjs pins its regex, and it is the check that
     names a MISSING libwebp with the right remedy; the trial is what catches a PRESENT libwebp
     behind a removed option */
  assert.match(src, /\/\^\\s\*\\S\+\\s\+libwebp\\s\/m/)
  assert.match(src, /ffmpeg can encode WebP \(libwebp\)/)
  /* and no macOS hint sends anyone to the slim formula */
  assert.doesNotMatch(src, /'brew (install|reinstall) ffmpeg'/, 'plain brew ffmpeg has no libwebp since 8.0')
  assert.match(src, /brew install ffmpeg-full/)
})

test('the trial encode reports a broken ffmpeg with its own first stderr line, and leaves nothing behind', () => {
  const dir = path.join(tmpDir('fftrial-'), 'trial')
  const broken = { bin: process.execPath, argv: ['-e', 'process.stderr.write("Unrecognized option \'fps_mode\'.\\n"); process.exit(1)'] }
  assert.throws(() => trialEncode(dir, broken), /Unrecognized option 'fps_mode'/)
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, 'probe frames left behind after a failure')
  const silent = { bin: process.execPath, argv: ['-e', 'process.exit(0)'] }
  assert.throws(() => trialEncode(dir, silent), /produced no frames/)
})

test('this machine\'s ffmpeg parses, and the flag the helper picks is one it accepts', NEEDS_FF, () => {
  const v = ffmpegVersion()
  assert.ok(v && v.major >= 4, `unexpected banner: ${JSON.stringify(v)}`)
  const dir = path.join(tmpDir('ffflag-'), 'trial')
  assert.ok(trialEncode(dir) >= 1, `${passthroughArgs(v).join(' ')} was rejected by ${v && v.raw}`)
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('probe-')).length, 0, 'probe frames left behind')
})

test('the README does not send Mac users to the slim Homebrew formula', () => {
  const s = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.doesNotMatch(s, /`brew install ffmpeg`/, 'plain brew ffmpeg cannot encode WebP')
  assert.match(s, /brew install ffmpeg-full/)
})
