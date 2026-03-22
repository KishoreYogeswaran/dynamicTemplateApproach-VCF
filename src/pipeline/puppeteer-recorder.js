/**
 * Puppeteer Scene Recorder
 *
 * Uses Puppeteer's native screencast API to record the browser tab directly
 * as a WebM, then muxes with audio via FFmpeg.
 *
 * Key: waits for all media to load BEFORE starting the screencast,
 * then triggers playback so audio/avatar/animations are perfectly synced.
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
 *
 * @param {object} opts
 * @param {string} opts.htmlPath      — path to scene HTML file
 * @param {string} opts.outputPath    — output MP4 path
 * @param {string} [opts.audioPath]   — local audio file to mux in
 * @param {number} [opts.durationMs]  — scene duration in ms
 * @param {number} [opts.fps]         — frames per second (default: 24)
 * @returns {{ success, outputPath, durationMs, error? }}
 */
export async function recordScene({
  htmlPath,
  outputPath,
  audioPath = '',
  durationMs = 0,
  fps = 24,
}) {
  // Determine duration
  let duration = durationMs;
  if (!duration && audioPath) {
    const secs = await getDurationSeconds(audioPath);
    if (secs > 0) duration = Math.ceil(secs * 1000);
  }
  if (!duration) duration = 10000;

  // Add buffer for last animation to finish
  const totalDuration = duration + 1500;

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
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Load the HTML — the page script will try to auto-play,
    // but we override by pausing everything after load
    await page.goto(`file://${htmlPath}`, {
      waitUntil: 'networkidle0',
      timeout: 60000,
    });

    // Step 1: Pause ALL media and wait for them to be loadable
    await page.evaluate(() => {
      const audio = document.getElementById('scene-audio');
      const allVideos = document.querySelectorAll('video');
      if (audio) { audio.pause(); audio.currentTime = 0; }
      allVideos.forEach(v => { v.pause(); v.currentTime = 0; });
    });

    // Wait for all media elements to be ready
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

    console.log(`    [rec] Media ready, starting screencast...`);

    // Step 2: Reset everything to time zero
    await page.evaluate(() => {
      const audio = document.getElementById('scene-audio');
      const allVideos = document.querySelectorAll('video');
      if (audio) { audio.pause(); audio.currentTime = 0; }
      allVideos.forEach(v => { v.pause(); v.currentTime = 0; });
      // Reset any GSAP animations that may have started
      if (typeof gsap !== 'undefined') { gsap.globalTimeline.clear(); }
      // Re-hide all animated elements
      document.querySelectorAll('[id^="header_"], [id^="bullet_"], [id^="keyphrase_"], [id^="subheader_"]').forEach(el => {
        el.style.opacity = '0';
      });
    });

    // Step 3: Trigger playback FIRST, then immediately start screencast.
    // Measure the gap so we can trim it from the audio to maintain lip sync.
    const playStartTime = Date.now();

    await page.evaluate(() => {
      const audio = document.getElementById('scene-audio');
      const allVideos = [...document.querySelectorAll('video')];

      // Start animations
      if (typeof triggerAnimations === 'function') {
        triggerAnimations();
      }

      // Start ALL videos at time 0 simultaneously
      allVideos.forEach(v => {
        v.currentTime = 0;
        v.play().catch(() => {});
      });

      // Start audio at time 0
      if (audio && audio.src && audio.src !== window.location.href) {
        audio.currentTime = 0;
        audio.play().catch(() => {});
      }
    });

    // Step 4: Start screencast immediately after triggering playback
    const recorder = await page.screencast({
      path: webmPath,
      speed: 1,
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    // The screencast starts AFTER playback — it missed the first N ms.
    // The video in the WebM shows the avatar already N ms into playing,
    // but the audio file starts at t=0. So we trim N ms from audio start.
    const audioOffsetSec = (Date.now() - playStartTime) / 1000;
    console.log(`    [rec] Audio offset: ${(audioOffsetSec * 1000).toFixed(0)}ms`);

    // Step 5: Wait for scene to play out
    await sleep(totalDuration);

    // Stop recording
    await recorder.stop();

    console.log(`    [rec] Screencast done, encoding to MP4...`);

    // Step 6: Convert WebM to MP4 and mux with original audio file.
    // Use -ss on audio input to skip the gap the screencast missed,
    // so audio and video start at the same playback moment.
    if (audioPath) {
      const audioDur = await getDurationSeconds(audioPath);
      await execFileAsync('ffmpeg', [
        '-y',
        '-fflags', '+genpts',
        '-i', webmPath,
        '-ss', String(audioOffsetSec),
        '-i', audioPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '21',
        '-r', String(fps),
        '-vsync', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-t', String(audioDur > 0 ? audioDur : totalDuration / 1000),
        outputPath,
      ], { timeout: 120000 });
    } else {
      await execFileAsync('ffmpeg', [
        '-y',
        '-fflags', '+genpts',
        '-i', webmPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '21',
        '-r', String(fps),
        '-vsync', 'cfr',
        '-pix_fmt', 'yuv420p',
        '-an',
        outputPath,
      ], { timeout: 120000 });
    }

    // Clean up screencast WebM
    await unlink(webmPath).catch(() => {});

    const finalSize = (await stat(outputPath)).size;
    console.log(`    [rec] Done ${(finalSize / 1024 / 1024).toFixed(1)}MB`);

    return { success: true, outputPath, durationMs: totalDuration };

  } catch (err) {
    return { success: false, error: err.message };
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
