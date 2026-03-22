/**
 * Puppeteer Scene Recorder
 *
 * Uses page.screencast() for video capture during browser playback,
 * then muxes with the original audio file via FFmpeg.
 *
 * Key sync strategy:
 * 1. Start screencast (captures VFR frames from t=0)
 * 2. Start playback (media begins at t=offset)
 * 3. Detect actual 'playing' event to measure true offset
 * 4. FFmpeg muxes with -itsoffset to delay audio by that amount
 * 5. VFR timestamps are preserved (no CFR conversion) to avoid frame redistribution drift
 */

import puppeteer from 'puppeteer';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdir, stat, unlink } from 'fs/promises';
import { dirname } from 'path';

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
  fps = 24,
}) {
  let duration = durationMs;
  if (!duration && audioPath) {
    const secs = await getDurationSeconds(audioPath);
    if (secs > 0) duration = Math.ceil(secs * 1000);
  }
  if (!duration) duration = 10000;

  const totalDuration = duration;

  await mkdir(dirname(outputPath), { recursive: true });

  const webmPath = outputPath.replace('.mp4', '_screencast.webm');

  console.log(`    [rec] Recording ${(totalDuration / 1000).toFixed(1)}s at ${fps}fps...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Expose function for the page to report when media actually starts playing
    let playingResolve;
    const playingPromise = new Promise(r => { playingResolve = r; });
    await page.exposeFunction('_onPlaybackStarted', () => {
      playingResolve(Date.now());
    });

    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'networkidle0',
      timeout: 60000,
    });

    // Pause all media and wait for ready
    await page.evaluate(() => {
      const audio = document.getElementById('scene-audio');
      const allVideos = document.querySelectorAll('video');
      if (audio) { audio.pause(); audio.currentTime = 0; }
      allVideos.forEach(v => { v.pause(); v.currentTime = 0; });
    });

    await page.evaluate(() => {
      return new Promise((resolve) => {
        const audio = document.getElementById('scene-audio');
        const allVideos = [...document.querySelectorAll('video')];
        const hasAudio = audio && audio.src && audio.src !== window.location.href;

        let pending = 0;
        function done() { if (--pending <= 0) resolve(); }

        if (hasAudio) {
          pending++;
          if (audio.readyState >= 3) done();
          else audio.addEventListener('canplaythrough', done, { once: true });
        }

        allVideos.forEach(v => {
          if (v.src || v.querySelector('source')) {
            pending++;
            if (v.readyState >= 3) done();
            else {
              v.addEventListener('canplaythrough', done, { once: true });
              v.addEventListener('error', done, { once: true });
            }
          }
        });

        if (pending === 0) resolve();
        setTimeout(() => resolve(), 10000);
      });
    });

    console.log(`    [rec] Media ready, starting recording...`);

    // Reset to time zero and disable looping so videos freeze on last frame
    await page.evaluate(() => {
      const audio = document.getElementById('scene-audio');
      const allVideos = document.querySelectorAll('video');
      if (audio) { audio.pause(); audio.currentTime = 0; }
      allVideos.forEach(v => { v.pause(); v.currentTime = 0; v.loop = false; });
      if (typeof gsap !== 'undefined') { gsap.globalTimeline.clear(); }
      document.querySelectorAll('[id^="header_"], [id^="bullet_"], [id^="keyphrase_"], [id^="subheader_"]').forEach(el => {
        el.style.opacity = '0';
      });
    });

    // 1. Start screencast — captures frames from this moment
    const screencastStartMs = Date.now();
    const recorder = await page.screencast({
      path: webmPath,
      speed: 1,
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // 2. Start playback and listen for actual 'playing' event
    await page.evaluate(() => {
      const audio = document.getElementById('scene-audio');
      const avatarVideo = document.getElementById('avatar-video');
      const allVideos = [...document.querySelectorAll('video')];
      const hasAudio = audio && audio.src && audio.src !== window.location.href;

      // Listen for the actual 'playing' event on whichever media drives audio
      // This fires when the media pipeline has actually started decoding
      if (avatarVideo && !avatarVideo.muted) {
        avatarVideo.addEventListener('playing', () => window._onPlaybackStarted(), { once: true });
      } else if (hasAudio) {
        audio.addEventListener('playing', () => window._onPlaybackStarted(), { once: true });
      } else {
        // No audio source — signal immediately
        window._onPlaybackStarted();
      }

      if (typeof triggerAnimations === 'function') {
        triggerAnimations();
      }

      allVideos.forEach(v => {
        v.currentTime = 0;
        v.play().catch(() => {});
      });

      if (hasAudio) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
    });

    // Wait for actual playback to start (with timeout fallback)
    const actualPlayMs = await Promise.race([
      playingPromise,
      sleep(3000).then(() => Date.now()),
    ]);

    const offsetSec = (actualPlayMs - screencastStartMs) / 1000;
    console.log(`    [rec] Screencast-to-play offset: ${(offsetSec * 1000).toFixed(0)}ms`);

    // 3. Wait for scene to play out
    await sleep(totalDuration);

    // 4. Stop screencast
    await recorder.stop();

    console.log(`    [rec] Screencast done, encoding to MP4...`);

    // 5. Mux video + audio
    // IMPORTANT: No -vsync cfr or -r flag — preserve original VFR timestamps.
    // CFR conversion redistributes frames and causes cumulative drift.
    if (audioPath) {
      const audioDur = await getDurationSeconds(audioPath);
      await execFileAsync('ffmpeg', [
        '-y',
        '-fflags', '+genpts',
        '-i', webmPath,
        // Delay audio to align with when playback actually started in the screencast
        '-itsoffset', String(offsetSec),
        '-i', audioPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '21',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-t', String(audioDur > 0 ? audioDur : totalDuration / 1000),
        outputPath,
      ], { timeout: 120000 });
    } else {
      // No audio
      await execFileAsync('ffmpeg', [
        '-y',
        '-fflags', '+genpts',
        '-i', webmPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '21',
        '-pix_fmt', 'yuv420p',
        '-an',
        outputPath,
      ], { timeout: 120000 });
    }

    // Clean up
    await unlink(webmPath).catch(() => {});

    const finalSize = (await stat(outputPath)).size;
    console.log(`    [rec] Done ${(finalSize / 1024 / 1024).toFixed(1)}MB`);

    return { success: true, outputPath, durationMs: totalDuration };

  } catch (err) {
    console.error(`    [rec] Error:`, err);
    return { success: false, error: String(err) };
  } finally {
    await browser.close();
  }
}

/**
 * Record multiple scenes in sequence.
 */
export async function recordAllScenes(scenes, opts = {}) {
  const { fps = 24 } = opts;
  const results = [];

  for (const scene of scenes) {
    console.log(`  [rec] Recording ${scene.sceneId}...`);
    const result = await recordScene({
      htmlPath: scene.htmlPath,
      outputPath: scene.outputPath,
      audioPath: scene.audioPath || '',
      durationMs: scene.durationMs || 0,
      fps,
    });
    results.push({ sceneId: scene.sceneId, ...result });
  }

  return results;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
