/**
 * WAN 2.2 Speech-to-Video Client (JS port)
 *
 * Generates talking-head video from audio + reference image
 * using the WaveSpeed AI API.
 */

import { writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { requireEnv } from '../utils/env.js';

export class WanS2VClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey] — falls back to WAVESPEED_API_KEY env
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || requireEnv('WAVESPEED_API_KEY');
    this.baseUrl = 'https://api.wavespeed.ai/api/v3';
  }

  get _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  // ------------------------------------------------------------------
  // Core API
  // ------------------------------------------------------------------

  /**
   * Submit a speech-to-video generation job.
   *
   * @param {object} opts
   * @param {string} opts.audioUrl   — public URL of the audio file
   * @param {string} opts.imageUrl   — public URL of the reference image
   * @param {string} [opts.prompt]   — optional motion prompt
   * @param {string} [opts.resolution] — '480p' (default) | '720p'
   * @param {number} [opts.seed]     — -1 for random
   * @returns {{ success, videoUrl?, requestId?, processingTime?, error? }}
   */
  async generateVideo({
    audioUrl,
    imageUrl,
    prompt = '',
    resolution = '480p',
    seed = -1,
  }) {
    try {
      const url = `${this.baseUrl}/wavespeed-ai/wan-2.2/speech-to-video`;
      const begin = Date.now();

      const response = await fetch(url, {
        method: 'POST',
        headers: this._headers,
        body: JSON.stringify({ audio: audioUrl, image: imageUrl, prompt, resolution, seed }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        return { success: false, error: `WaveSpeed ${response.status}: ${await response.text()}` };
      }

      const { data } = await response.json();
      const requestId = data.id;

      // Poll for completion
      const videoUrl = await this._pollForCompletion(requestId, begin);
      if (!videoUrl) {
        return { success: false, error: 'Video generation failed or timed out' };
      }

      return {
        success: true,
        videoUrl,
        requestId,
        processingTime: (Date.now() - begin) / 1000,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Download a video from URL to a local path.
   */
  async downloadVideo(videoUrl, outputPath) {
    const response = await fetch(videoUrl, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, buffer);
    return true;
  }

  /**
   * Generate + download in one call, with retries.
   *
   * @param {object} opts — same as generateVideo plus:
   * @param {string}  opts.outputPath — local file path for the video
   * @param {number}  [opts.maxRetries=1]
   */
  async generateAndDownload({ outputPath, maxRetries = 1, ...genOpts }) {
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`[WAN] Retry ${attempt}/${maxRetries} — waiting 10s…`);
        await sleep(10_000);
      }

      const result = await this.generateVideo(genOpts);

      if (!result.success) {
        lastError = result.error;
        continue;
      }

      try {
        await this.downloadVideo(result.videoUrl, outputPath);
        return { ...result, outputPath, downloadSuccess: true, totalAttempts: attempt + 1 };
      } catch (err) {
        lastError = `Generation OK but download failed: ${err.message}`;
        continue;
      }
    }

    return { success: false, error: lastError, totalAttempts: maxRetries + 1 };
  }

  // ------------------------------------------------------------------
  // Polling
  // ------------------------------------------------------------------

  async _pollForCompletion(requestId, startTime, timeout = 1_500_000) {
    const resultUrl = `${this.baseUrl}/predictions/${requestId}/result`;
    const headers = { Authorization: `Bearer ${this.apiKey}` };

    let retryMismatch = 0;
    const maxMismatch = 1;
    let lastStatus = null;
    let pollCount = 0;

    while (Date.now() - startTime < timeout) {
      pollCount++;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      const res = await fetch(resultUrl, { headers, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) {
        console.error(`[WAN] Poll error #${pollCount}: HTTP ${res.status}`);
        return null;
      }

      const { data } = await res.json();

      // Request ID validation
      if (data.id && data.id !== requestId) {
        retryMismatch++;
        if (retryMismatch > maxMismatch) {
          throw new Error(`WAN request ID mismatch: expected ${requestId}, got ${data.id}`);
        }
        await sleep(15_000);
        continue;
      }
      retryMismatch = 0;

      const status = data.status;

      if (status !== lastStatus || pollCount % 30 === 0) {
        console.log(`[WAN] Poll #${pollCount} — ${status} (${elapsed}s)`);
        lastStatus = status;
      }

      if (status === 'completed') return data.outputs[0];
      if (status === 'failed') {
        console.error(`[WAN] Task failed: ${data.error || 'unknown'}`);
        return null;
      }

      await sleep(2_000);
    }

    console.error(`[WAN] Timed out after ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return null;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
