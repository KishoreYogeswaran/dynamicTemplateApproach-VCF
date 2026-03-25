/**
 * Video Stitcher
 *
 * Concatenates scene MP4 files into a single final video using FFmpeg.
 * Supports freeze-frame gaps between scenes for a natural pause.
 */

import { writeFile, mkdir, stat, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { dirname } from 'path';

const execFileAsync = promisify(execFile);

/**
 * Stitch scene videos into a final MP4, then downscale to 720p.
 *
 * @param {object} opts
 * @param {string[]} opts.inputPaths     — ordered array of scene MP4 paths
 * @param {string}   opts.outputPath     — final output MP4 path
 * @param {number}   [opts.gapMs]        — freeze-frame pause between scenes in ms (default: 700, 0 = hard cut)
 * @returns {{ success, outputPath, durationSeconds?, fileSizeMB?, error? }}
 */
export async function stitchScenes({ inputPaths, outputPath, gapMs = 700 }) {
  if (!inputPaths.length) {
    return { success: false, error: 'No input files provided' };
  }

  await mkdir(dirname(outputPath), { recursive: true });

  // Stitch to a 1080p intermediate, then downscale to 720p
  const fullResPath = outputPath.replace('.mp4', '_1080p.mp4');

  let stitchResult;

  // Single scene — just copy
  if (inputPaths.length === 1) {
    console.log('  [stitch] Single scene — copying as intermediate.');
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPaths[0],
      '-c', 'copy',
      fullResPath,
    ], { timeout: 60000 });

    const info = await stat(fullResPath);
    stitchResult = {
      success: true,
      outputPath: fullResPath,
      fileSizeMB: (info.size / 1024 / 1024).toFixed(1),
    };
  } else if (gapMs > 0) {
    stitchResult = await stitchWithFreezeGap({ inputPaths, outputPath: fullResPath, gapMs });
  } else {
    stitchResult = await stitchHardCut({ inputPaths, outputPath: fullResPath });
  }

  if (!stitchResult.success) {
    return stitchResult;
  }

  // Downscale to 720p
  const finalResult = await downscaleTo720p(fullResPath, outputPath);
  await unlink(fullResPath).catch(() => {});
  return finalResult;
}

/**
 * Downscale a video to 1280x720 (720p) with proper aspect ratio handling.
 * Uses the same approach as the Python pipeline's FFmpeg command.
 */
async function downscaleTo720p(inputPath, outputPath) {
  console.log(`  [stitch] Downscaling to 720p...`);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-pix_fmt', 'yuv420p',
      outputPath,
    ], { timeout: 600000 });

    const info = await stat(outputPath);
    const duration = await getDuration(outputPath);

    console.log(`  [stitch] ✓ Final video (720p): ${duration.toFixed(1)}s, ${(info.size / 1024 / 1024).toFixed(1)}MB`);

    return {
      success: true,
      outputPath,
      durationSeconds: duration,
      fileSizeMB: (info.size / 1024 / 1024).toFixed(1),
    };
  } catch (err) {
    console.error(`  [stitch] Downscale failed: ${err.message}`);
    return { success: false, error: `Downscale failed: ${err.message}` };
  }
}

/**
 * Concat with freeze-frame gap between scenes.
 * Uses FFmpeg filter_complex: tpad clones the last frame, apad adds silence.
 * Then concat filter joins them all in one pass.
 */
async function stitchWithFreezeGap({ inputPaths, outputPath, gapMs }) {
  const gapSec = gapMs / 1000;
  const n = inputPaths.length;

  console.log(`  [stitch] Concatenating ${n} scenes with ${gapMs}ms freeze-frame gaps...`);

  // Build inputs
  const inputs = inputPaths.flatMap(p => ['-i', p]);

  // Build filter_complex:
  // - Each scene except the last gets tpad (freeze last frame) + apad (silence)
  // - Then all streams get concat'd
  const filters = [];
  const concatInputs = [];

  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;

    if (isLast) {
      // Last scene — no gap needed
      filters.push(`[${i}:v]null[v${i}]`);
      filters.push(`[${i}:a]anull[a${i}]`);
    } else {
      // Add freeze-frame + silence padding
      filters.push(`[${i}:v]tpad=stop_mode=clone:stop_duration=${gapSec}[v${i}]`);
      filters.push(`[${i}:a]apad=pad_dur=${gapSec}[a${i}]`);
    }

    concatInputs.push(`[v${i}][a${i}]`);
  }

  filters.push(`${concatInputs.join('')}concat=n=${n}:v=1:a=1[vout][aout]`);

  const filterComplex = filters.join(';');

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      outputPath,
    ], { timeout: 600000 });

    const info = await stat(outputPath);
    const duration = await getDuration(outputPath);

    console.log(`  [stitch] ✓ Final video: ${duration.toFixed(1)}s, ${(info.size / 1024 / 1024).toFixed(1)}MB`);

    return {
      success: true,
      outputPath,
      durationSeconds: duration,
      fileSizeMB: (info.size / 1024 / 1024).toFixed(1),
    };
  } catch (err) {
    console.error(`  [stitch] Filter concat failed: ${err.message}`);
    // Fall back to hard cut
    console.log(`  [stitch] Falling back to hard cut...`);
    return stitchHardCut({ inputPaths, outputPath });
  }
}

/**
 * Hard-cut concat using FFmpeg concat demuxer (fast, no re-encode).
 */
async function stitchHardCut({ inputPaths, outputPath }) {
  const concatListPath = outputPath.replace('.mp4', '_concat.txt');
  const concatContent = inputPaths.map(p => `file '${p}'`).join('\n');
  await writeFile(concatListPath, concatContent, 'utf-8');

  console.log(`  [stitch] Concatenating ${inputPaths.length} scenes (hard cut)...`);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      outputPath,
    ], { timeout: 300000 });

    await unlink(concatListPath).catch(() => {});

    const info = await stat(outputPath);
    const duration = await getDuration(outputPath);

    console.log(`  [stitch] ✓ Final video: ${duration.toFixed(1)}s, ${(info.size / 1024 / 1024).toFixed(1)}MB`);

    return {
      success: true,
      outputPath,
      durationSeconds: duration,
      fileSizeMB: (info.size / 1024 / 1024).toFixed(1),
    };
  } catch (err) {
    await unlink(concatListPath).catch(() => {});
    return { success: false, error: err.message };
  }
}

async function getDuration(filePath) {
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
