/* The WebP encode build-frames.mjs runs, and the preflight that proves it.

   FFmpeg 9.0 (August 2026) removed `-vsync`; its replacement `-fps_mode` exists only from 5.1
   (June 2022). Homebrew ships 9, Ubuntu 22.04's apt still ships 4.4 - so a hard-coded flag
   breaks one of those populations whichever way it is written, and it breaks at step 4 of 4,
   after the storyboard, every keyframe and every tween have been paid for. The flag is chosen
   from the ffmpeg actually on PATH, in exactly this one place, and doctor.mjs pushes THIS
   module's arg list through the real encoder rather than trusting an encoder listing: a
   listing cannot see an option that no longer exists. Ported from the sibling scroll-flight,
   where an outside review found the failure and CI's first run then found a second one on the
   same step (Homebrew's plain `ffmpeg` formula has no libwebp at all). */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const run = (bin, argv) => execFileSync(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })

/* "ffmpeg version 9.0.1 ...", "ffmpeg version 8.1.1-full_build-www.gyan.dev", "ffmpeg version
   4.4.2-0ubuntu0.22.04.1", "ffmpeg version n7.1". Git snapshots ("N-112345-g...") do not parse
   and read as null. Exported so the banners can be pinned without an ffmpeg of each vintage. */
export function parseFfmpegVersion (firstLine) {
  const m = /ffmpeg version\s+n?v?(\d+)(?:\.(\d+))?/i.exec(String(firstLine || ''))
  return m ? { major: Number(m[1]), minor: Number(m[2] || 0), raw: String(firstLine).trim() } : null
}

let versionCache
export function ffmpegVersion () {
  if (versionCache !== undefined) return versionCache
  try {
    versionCache = parseFfmpegVersion(run('ffmpeg', ['-version']).split('\n')[0])
  } catch (_) { versionCache = null }
  return versionCache
}

/* Unparsed (a git snapshot, or no ffmpeg) is treated as modern: the only population that needs
   the old flag is 4.x, and every 4.x banner parses. */
export function passthroughArgs (ver = ffmpegVersion()) {
  const old = ver && (ver.major < 5 || (ver.major === 5 && ver.minor < 1))
  return old ? ['-vsync', '0'] : ['-fps_mode', 'passthrough']
}

export function webpEncodeArgs (quality, ver = ffmpegVersion()) {
  return [...passthroughArgs(ver), '-c:v', 'libwebp', '-quality', String(quality), '-preset', 'picture']
}

/* Half a second of synthetic video through the exact arg list build-frames.mjs uses. Returns
   the number of frames written; throws with ffmpeg's own first line of stderr when it cannot,
   so the doctor's report says WHY rather than "encoder missing". Cleans up after itself.
   bin/argv exist for the suite, which drives the failure branch with a stand-in that exits
   like a broken ffmpeg; the doctor never passes them. */
export function trialEncode (dir, { bin = 'ffmpeg', argv = null } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const pattern = path.join(dir, 'probe-%04d.webp')
  try {
    run(bin, argv || ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=0.5:size=64x36:rate=6',
      '-vf', 'fps=6', ...webpEncodeArgs(78), pattern])
  } catch (e) {
    const line = String(e.stderr || e.message || e).split('\n').find(l => l.trim()) || 'ffmpeg failed'
    throw new Error(line.trim())
  }
  const files = fs.readdirSync(dir).filter(f => /^probe-\d{4}\.webp$/.test(f))
  const good = files.filter(f => fs.statSync(path.join(dir, f)).size > 0).length
  for (const f of files) { try { fs.rmSync(path.join(dir, f)) } catch (_) {} }
  if (!good) throw new Error('the trial encode produced no frames')
  return good
}
