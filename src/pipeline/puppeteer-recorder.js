/**
 * Playwright Scene Recorder — Screenshot-based
 *
 * Captures individual frames via page.screenshot() and compiles with FFmpeg.
 * This completely bypasses Playwright's VP8 video encoder, eliminating
 * color banding artifacts on dark backgrounds.
 *
 * Flow:
 * 1. Launch browser, navigate to HTML
 * 2. Release playback (avatar + audio + animations)
 * 3. Capture screenshots in real-time at target FPS
 * 4. Map captured frames to exact output timeline
 * 5. Compile to H.264 MP4 with FFmpeg
 * 6. Mux with audio
 */

import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, stat, unlink, rename, readdir, rmdir, copyFile } from 'fs/promises';
import { dirname, join } from 'path';

const execFileAsync = promisify(execFile);

/**
 * Get media duration in seconds using ffprobe.
 */
async function getDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    return parseFloat(stdout.trim());
  } catch {
    return 0;
  }
}

/**
 * Record a single scene HTML to MP4 using screenshot-based capture.
 */
export async function recordScene({
  htmlPath,
  outputPath,
  audioPath = '',
  durationMs = 0,
  fps = 24,
}) {
  let duration = durationMs;
  if (!duration && audioPath) {
    const secs = await getDurationSeconds(audioPath);
    if (secs > 0) duration = Math.ceil(secs * 1000);
  }
  if (!duration) duration = 10000;

  await mkdir(dirname(outputPath), { recursive: true });

  const framesDir = join(dirname(outputPath), `_frames_${Date.now()}`);
  await mkdir(framesDir, { recursive: true });
  const silentMp4Path = outputPath.replace('.mp4', '_silent.mp4');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });

  try {
    // No recordVideo — we capture frames ourselves
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    // Block auto-play during page load so we control when playback starts.
    await page.addInitScript(() => {
      window.__playbackBlocked = true;
      window.__pendingPlays = [];

      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (window.__playbackBlocked) {
          this.pause();
          window.__pendingPlays.push(this);
          return Promise.resolve();
        }
        return origPlay.call(this);
      };

      const origReadyState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        get() {
          if (window.__playbackBlocked) return 0;
          return origReadyState.get.call(this);
        },
        configurable: true,
      });

      ['canplay', 'canplaythrough', 'playing', 'play', 'loadeddata', 'loadedmetadata'].forEach(evtName => {
        document.addEventListener(evtName, (e) => {
          if (window.__playbackBlocked) {
            e.stopImmediatePropagation();
            e.stopPropagation();
          }
        }, true);
      });
    });

    // Navigate — auto-play is blocked
    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);

    // Release playback
    await page.evaluate(() => {
      window.__playbackBlocked = false;

      const allMedia = [...document.querySelectorAll('video'), document.getElementById('scene-audio')].filter(Boolean);
      allMedia.forEach(el => { el.currentTime = 0; });

      if (typeof triggerAnimations === 'function') {
        triggerAnimations();
      }

      window.__pendingPlays.forEach(el => {
        el.currentTime = 0;
        HTMLMediaElement.prototype.play.call(el);
      });
    });

    // Let avatar video decode first frames + audio buffer before capturing
    await page.waitForTimeout(150);

    // ── Screenshot-based frame capture ──────────────────────────
    const audioDur = audioPath ? await getDurationSeconds(audioPath) : 0;
    const videoDuration = audioDur > 0 ? audioDur : (duration / 1000);
    const captureDurationMs = videoDuration * 1000 + 500; // small buffer

    console.log(`    [rec] Capturing frames for ${videoDuration.toFixed(1)}s at ${fps}fps...`);

    const capturedFrames = []; // { timeMs, index }
    const captureStart = Date.now();
    let frameIndex = 0;

    // Capture as fast as possible for the scene duration
    while (Date.now() - captureStart < captureDurationMs) {
      const timeMs = Date.now() - captureStart;
      const frameName = `cap_${String(frameIndex).padStart(5, '0')}.jpeg`;

      await page.screenshot({
        path: join(framesDir, frameName),
        type: 'jpeg',
        quality: 95,
      });

      capturedFrames.push({ timeMs, file: frameName });
      frameIndex++;
    }

    console.log(`    [rec] Captured ${capturedFrames.length} frames in ${((Date.now() - captureStart) / 1000).toFixed(1)}s`);

    await context.close();

    // ── Assemble output frame sequence ──────────────────────────
    // Map each target frame to the nearest captured frame
    const totalOutputFrames = Math.ceil(videoDuration * fps);

    for (let i = 0; i < totalOutputFrames; i++) {
      const targetMs = (i / fps) * 1000;

      // Find nearest captured frame
      let best = capturedFrames[0];
      let bestDist = Math.abs(best.timeMs - targetMs);
      for (const f of capturedFrames) {
        const dist = Math.abs(f.timeMs - targetMs);
        if (dist < bestDist) {
          best = f;
          bestDist = dist;
        }
      }

      const outputName = `frame_${String(i).padStart(5, '0')}.jpeg`;
      await copyFile(join(framesDir, best.file), join(framesDir, outputName));
    }

    console.log(`    [rec] Assembled ${totalOutputFrames} output frames, compiling to MP4...`);

    // ── Compile to H.264 ────────────────────────────────────────
    await execFileAsync('ffmpeg', [
      '-y',
      '-framerate', String(fps),
      '-i', join(framesDir, 'frame_%05d.jpeg'),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-an',
      silentMp4Path,
    ], { timeout: 120000 });

    // Clean up frames
    const allFiles = await readdir(framesDir);
    for (const f of allFiles) await unlink(join(framesDir, f));
    await rmdir(framesDir).catch(() => {});

    // Mux with audio
    if (audioPath) {
      console.log(`    [rec] Muxing audio (${audioDur.toFixed(1)}s)...`);
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', silentMp4Path,
        '-i', audioPath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        outputPath,
      ], { timeout: 120000 });
      await unlink(silentMp4Path).catch(() => {});
    } else {
      await rename(silentMp4Path, outputPath);
    }

    const finalSize = (await stat(outputPath)).size;
    console.log(`    [rec] Done ${(finalSize / 1024 / 1024).toFixed(1)}MB`);

    return { success: true, outputPath, durationMs: duration };

  } catch (err) {
    console.error(`    [rec] Error:`, err);
    // Clean up frames on error
    const allFiles = await readdir(framesDir).catch(() => []);
    for (const f of allFiles) await unlink(join(framesDir, f)).catch(() => {});
    await rmdir(framesDir).catch(() => {});
    return { success: false, error: String(err) };
  } finally {
    await browser.close();
  }
}

/**
 * Record multiple scenes in sequence.
 */
export async function recordAllScenes(scenes) {
  const results = [];

  for (const scene of scenes) {
    console.log(`  [rec] Recording ${scene.sceneId}...`);
    const result = await recordScene({
      htmlPath: scene.htmlPath,
      outputPath: scene.outputPath,
      audioPath: scene.audioPath || '',
      durationMs: scene.durationMs || 0,
    });
    results.push({ sceneId: scene.sceneId, ...result });
  }

  return results;
}
