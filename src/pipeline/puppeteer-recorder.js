/**
 * Playwright Scene Recorder
 *
 * Simple approach (same as colleague's proven Playwright script):
 * 1. Create context with video recording
 * 2. Navigate — page auto-plays (avatar video has audio, drives lip sync)
 * 3. Wait for duration
 * 4. Close context → video file finalized
 * 5. Trim startup, convert to MP4
 * 6. Mux with audio file
 *
 * Lip sync works because avatar video HAS audio baked in (Mode 1).
 * The avatar plays with its own audio track — lip sync is inherent.
 */

import { chromium } from 'playwright';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, stat, unlink, rename, readdir, rmdir } from 'fs/promises';
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
 * Record a single scene HTML to MP4.
 */
export async function recordScene({
  htmlPath,
  outputPath,
  audioPath = '',
  durationMs = 0,
}) {
  let duration = durationMs;
  if (!duration && audioPath) {
    const secs = await getDurationSeconds(audioPath);
    if (secs > 0) duration = Math.ceil(secs * 1000);
  }
  if (!duration) duration = 10000;

  // Extra time for page load + animation buffer
  const recordDurationMs = duration + 1500;

  await mkdir(dirname(outputPath), { recursive: true });

  const recordDir = join(dirname(outputPath), '_recordings');
  await mkdir(recordDir, { recursive: true });
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

  let recordedVideoPath = null;

  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      recordVideo: {
        dir: recordDir,
        size: { width: 1920, height: 1080 },
      },
    });

    const page = await context.newPage();
    const recordingStartMs = Date.now();

    // Block auto-play during page load so we control when playback starts.
    // This ensures all images/resources are loaded before the avatar begins.
    await page.addInitScript(() => {
      window.__playbackBlocked = true;
      window.__pendingPlays = [];

      // 1. Block play() calls
      const origPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (window.__playbackBlocked) {
          this.pause();
          window.__pendingPlays.push(this);
          return Promise.resolve();
        }
        return origPlay.call(this);
      };

      // 2. Fake readyState as 0 so Mode 1's synchronous check fails
      //    (forces it to use the event listener path instead)
      const origReadyState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
        get() {
          if (window.__playbackBlocked) return 0;
          return origReadyState.get.call(this);
        },
        configurable: true,
      });

      // 3. Block media events in capture phase so Mode 1/2 canplay listeners never fire
      ['canplay', 'canplaythrough', 'playing', 'play', 'loadeddata', 'loadedmetadata'].forEach(evtName => {
        document.addEventListener(evtName, (e) => {
          if (window.__playbackBlocked) {
            e.stopImmediatePropagation();
            e.stopPropagation();
          }
        }, true);
      });
    });

    // Navigate — auto-play is blocked, page loads silently
    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'networkidle',
      timeout: 60000,
    });
    await page.waitForLoadState('networkidle');

    // Brief settle for layout/paint (images are loaded, nothing is playing)
    await page.waitForTimeout(300);

    // Release playback — everything starts from t=0 together
    const playStartMs = Date.now();
    await page.evaluate(() => {
      window.__playbackBlocked = false;

      // Reset all media to t=0
      const allMedia = [...document.querySelectorAll('video'), document.getElementById('scene-audio')].filter(Boolean);
      allMedia.forEach(el => { el.currentTime = 0; });

      // Trigger animations fresh (Mode 1/2 never fired due to event blocking)
      if (typeof triggerAnimations === 'function') {
        triggerAnimations();
      }

      // Play all pending media from t=0
      window.__pendingPlays.forEach(el => {
        el.currentTime = 0;
        HTMLMediaElement.prototype.play.call(el);
      });
    });

    const trimSec = Math.max(0, (playStartMs - recordingStartMs) / 1000);
    console.log(`    [rec] Resources loaded, playback started at ${(trimSec * 1000).toFixed(0)}ms, recording ${(recordDurationMs / 1000).toFixed(1)}s...`);

    // Wait for scene to play out
    await page.waitForTimeout(recordDurationMs);

    // Finalize recording
    recordedVideoPath = await page.video().path();
    await context.close();

    console.log(`    [rec] Recording done, converting to MP4...`);

    // Trim startup + convert to MP4 (no audio — will mux separately)
    const audioDur = audioPath ? await getDurationSeconds(audioPath) : 0;
    const videoDuration = audioDur > 0 ? audioDur : (duration / 1000);

    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(trimSec),
      '-i', recordedVideoPath,
      '-t', String(videoDuration),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-an',
      silentMp4Path,
    ], { timeout: 120000 });

    await unlink(recordedVideoPath).catch(() => {});

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

    // Clean up
    const remaining = await readdir(recordDir).catch(() => []);
    if (remaining.length === 0) await rmdir(recordDir).catch(() => {});

    const finalSize = (await stat(outputPath)).size;
    console.log(`    [rec] Done ${(finalSize / 1024 / 1024).toFixed(1)}MB`);

    return { success: true, outputPath, durationMs: duration };

  } catch (err) {
    console.error(`    [rec] Error:`, err);
    if (recordedVideoPath) await unlink(recordedVideoPath).catch(() => {});
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
