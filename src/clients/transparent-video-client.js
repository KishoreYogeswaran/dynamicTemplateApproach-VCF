/**
 * Transparent Video Client (JS port)
 *
 * Background removal strategies:
 *   Primary:  WaveSpeed Bria FIBO API → native transparent ProRes 4444 MOV
 *   Fallback: Local rembg (u2net) → VP9+alpha WebM
 *
 * Also handles superimposing transparent video onto background images via ffmpeg.
 */

import { mkdir, stat, unlink } from 'fs/promises';
import { writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getEnv } from '../utils/env.js';

const execFileAsync = promisify(execFile);

export class TransparentVideoClient {
  static FIBO_ENDPOINT = 'bria/fibo/video-background-remover';
  static FIBO_POLL_INTERVAL = 5_000;  // ms
  static FIBO_TIMEOUT = 600_000;       // 10 min

  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey] — falls back to WAVESPEED_API_KEY env
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || getEnv('WAVESPEED_API_KEY');
    this.baseUrl = 'https://api.wavespeed.ai/api/v3';
    this.fps = 30;
    this.scaleWidth = 1280;
    this.characterHeightPct = 0.90;
  }

  get _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Remove background from a video.
   *
   * @param {object} opts
   * @param {string}  opts.inputVideo   — local path to WAN video
   * @param {string}  opts.outputDir    — directory for outputs
   * @param {string}  [opts.videoUrl]   — public URL (triggers FIBO path)
   * @returns {{ success, transparentVideo?, method?, error? }}
   */
  async removeBackground({ inputVideo, outputDir, videoUrl }) {
    await mkdir(outputDir, { recursive: true });

    if (videoUrl && this.apiKey) {
      return this._removeBgViaFibo({ videoUrl, inputVideo, outputDir });
    }
    return this._removeBgViaRembg({ inputVideo, outputDir });
  }

  /**
   * Superimpose transparent video onto a background image via ffmpeg.
   *
   * @param {object} opts
   * @param {string} opts.backgroundImage  — path to bg image
   * @param {string} opts.transparentVideo — path to transparent MOV/WebM
   * @param {string} opts.outputVideo      — output MP4 path
   * @param {string} opts.position         — 'left' | 'right'
   * @returns {{ success, outputVideo?, error? }}
   */
  async superimposeOnBackground({ backgroundImage, transparentVideo, outputVideo, position }) {
    try {
      const [bgW, bgH] = await this._getDimensions(backgroundImage);
      const [vidW, vidH] = await this._getDimensions(transparentVideo);

      const { x, y, scaleFilter } = this._calculatePositionAndScale(
        position, evenDim(bgW), evenDim(bgH), vidW, vidH,
      );

      const filterComplex =
        `[1:v]${scaleFilter}format=yuva420p,setpts=PTS-STARTPTS[fg];` +
        `[0:v]scale=${evenDim(bgW)}:${evenDim(bgH)}[bg];` +
        `[bg][fg]overlay=${x}:${y}:shortest=1:format=auto[out]`;

      await execFileAsync('ffmpeg', [
        '-loop', '1', '-i', backgroundImage,
        '-i', transparentVideo,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-shortest',
        '-y', outputVideo,
      ], { timeout: 300_000 });

      return { success: true, outputVideo };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // FIBO path (primary)
  // ------------------------------------------------------------------

  async _removeBgViaFibo({ videoUrl, inputVideo, outputDir }) {
    const MAX_ATTEMPTS = 3;
    const MIN_SIZE = 100 * 1024; // 100 KB
    const transparentPath = join(outputDir, 'character_fibo_transparent.mov');
    let lastError = 'Unknown error';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        console.log(`[FIBO] Retry ${attempt}/${MAX_ATTEMPTS} — waiting ${5 * attempt}s…`);
        await sleep(5_000 * attempt);
      }

      try {
        // 1. Submit + poll
        const outputUrl = await this._callFiboApi(videoUrl);
        if (!outputUrl) { lastError = 'FIBO returned no output URL'; continue; }

        // 2. Download
        if (!await this._downloadFile(outputUrl, transparentPath)) {
          lastError = 'Failed to download FIBO video'; continue;
        }

        // 3. Validate size
        const fileSize = (await stat(transparentPath)).size;
        if (fileSize < MIN_SIZE) {
          lastError = `FIBO video too small (${(fileSize / 1024).toFixed(1)} KB)`;
          await unlink(transparentPath).catch(() => { });
          continue;
        }

        console.log(`[FIBO] Success on attempt ${attempt} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
        return { success: true, transparentVideo: transparentPath, method: 'fibo' };
      } catch (err) {
        lastError = err.message;
      }
    }

    return { success: false, error: `FIBO failed after ${MAX_ATTEMPTS} attempts: ${lastError}` };
  }

  async _callFiboApi(videoUrl) {
    const endpoint = `${this.baseUrl}/${TransparentVideoClient.FIBO_ENDPOINT}`;
    const begin = Date.now();

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: this._headers,
      body: JSON.stringify({
        background_color: 'Transparent',
        output_container_and_codec: 'mov_proresks',
        preserve_audio: false,
        video: videoUrl,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) throw new Error(`FIBO submit failed: HTTP ${res.status} — ${await res.text()}`);

    const data = (await res.json()).data || {};
    if (!data.id) throw new Error(`FIBO response missing request ID`);

    return this._pollFibo(data.id, begin);
  }

  async _pollFibo(requestId, startTime) {
    const resultUrl = `${this.baseUrl}/predictions/${requestId}/result`;
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    let lastStatus = null;
    let pollCount = 0;

    while (Date.now() - startTime < TransparentVideoClient.FIBO_TIMEOUT) {
      pollCount++;

      const res = await fetch(resultUrl, { headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        console.error(`[FIBO] Poll error #${pollCount}: HTTP ${res.status}`);
        return null;
      }

      const data = (await res.json()).data || {};

      if (data.id && data.id !== requestId) {
        throw new Error(`FIBO request ID mismatch: expected ${requestId}, got ${data.id}`);
      }

      const status = data.status;
      if (status !== lastStatus || pollCount % 20 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[FIBO] Poll #${pollCount} — ${status} (${elapsed}s)`);
        lastStatus = status;
      }

      if (status === 'completed') {
        const outputs = data.outputs || [];
        if (!outputs.length) throw new Error('FIBO completed but outputs list is empty');
        return outputs[0];
      }
      if (status === 'failed') {
        console.error(`[FIBO] Task failed: ${data.error || 'unknown'}`);
        return null;
      }

      await sleep(TransparentVideoClient.FIBO_POLL_INTERVAL);
    }

    console.error(`[FIBO] Timed out after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return null;
  }

  // ------------------------------------------------------------------
  // rembg fallback path
  // ------------------------------------------------------------------

  async _removeBgViaRembg({ inputVideo, outputDir }) {
    try {
      const framesDir = join(outputDir, 'frames');
      const framesCutDir = join(outputDir, 'frames_cut');
      await mkdir(framesDir, { recursive: true });
      await mkdir(framesCutDir, { recursive: true });

      // Extract frames
      await execFileAsync('ffmpeg', [
        '-i', inputVideo,
        '-vf', `fps=${this.fps},scale=${this.scaleWidth}:-1:flags=lanczos`,
        '-y', `${framesDir}/%06d.png`,
      ], { timeout: 300_000 });

      // Apply rembg
      await execFileAsync('rembg', [
        'p', '-m', 'u2net', '-a', '-af', '240', '-ab', '10', '-ae', '10',
        framesDir, framesCutDir,
      ], { timeout: 2_400_000 });

      // Create transparent WebM
      const transparentVideo = join(outputDir, 'character_transparent.webm');
      await execFileAsync('ffmpeg', [
        '-r', String(this.fps), '-i', `${framesCutDir}/%06d.png`,
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
        '-y', transparentVideo,
      ], { timeout: 2_400_000 });

      return { success: true, transparentVideo, method: 'rembg' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  async _downloadFile(url, dest) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const buffer = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buffer);
      return true;
    } catch (err) {
      console.error(`[FIBO] Download failed: ${err.message}`);
      return false;
    }
  }

  async _getDimensions(filePath) {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const lines = stdout.trim().split('\n');
    return [parseInt(lines[0], 10), parseInt(lines[1], 10)];
  }

  _calculatePositionAndScale(position, bgW, bgH, vidW, vidH) {
    let maxWidth, xStart;

    if (position === 'left') {
      maxWidth = Math.floor(bgW * 0.5);
      xStart = 0;
    } else if (position === 'right') {
      maxWidth = Math.floor(bgW * 0.5);
      xStart = Math.floor(bgW * 0.5);
    } else {
      throw new Error(`Invalid position: '${position}'. Must be 'left' or 'right'.`);
    }

    let targetH = Math.floor(bgH * this.characterHeightPct);
    let targetW = Math.floor(targetH * (vidW / vidH));

    if (targetW > maxWidth) {
      targetW = maxWidth;
      targetH = Math.floor(targetW / (vidW / vidH));
    }

    targetW = evenDim(targetW);
    targetH = evenDim(targetH);

    const x = xStart;
    const y = bgH - targetH;
    const scaleFilter = `scale=${targetW}:${targetH},`;

    return { x, y, scaleFilter, targetW, targetH };
  }
}

function evenDim(n) { return n % 2 === 0 ? n : n - 1; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
