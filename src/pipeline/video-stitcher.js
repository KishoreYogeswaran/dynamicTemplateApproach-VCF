/**
 * Video Stitcher
 *
 * Concatenates scene MP4 files into a single final video using FFmpeg.
 * Supports optional crossfade transitions between scenes.
 */

import { writeFile, mkdir, stat, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';

const execFileAsync = promisify(execFile);

/**
 * Stitch scene videos into a final MP4.
 *
 * @param {object} opts
 * @param {string[]} opts.inputPaths     — ordered array of scene MP4 paths
 * @param {string}   opts.outputPath     — final output MP4 path
 * @param {number}   [opts.crossfadeMs]  — crossfade duration between scenes (0 = hard cut, default: 500)
 * @returns {{ success, outputPath, durationSeconds?, fileSizeMB?, error? }}
 */
export async function stitchScenes({ inputPaths, outputPath, crossfadeMs = 500 }) {
  if (!inputPaths.length) {
    return { success: false, error: 'No input files provided' };
  }

  await mkdir(dirname(outputPath), { recursive: true });

  // Single scene — just copy
  if (inputPaths.length === 1) {
    console.log('  [stitch] Single scene — copying as final video.');
    await execFileAsync('ffmpeg', [
      '-y', '-i', inputPaths[0],
      '-c', 'copy',
      outputPath,
    ], { timeout: 60000 });

    const info = await stat(outputPath);
    return {
      success: true,
      outputPath,
      fileSizeMB: (info.size / 1024 / 1024).toFixed(1),
    };
  }

  if (crossfadeMs > 0) {
    return stitchWithCrossfade({ inputPaths, outputPath, crossfadeMs });
  }

  return stitchWithConcat({ inputPaths, outputPath });
}

/**
 * Hard-cut concat using FFmpeg concat demuxer (fast, no re-encode).
 */
async function stitchWithConcat({ inputPaths, outputPath }) {
  // Create concat list file
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

/**
 * Crossfade concat using FFmpeg xfade filter (re-encodes).
 */
async function stitchWithCrossfade({ inputPaths, outputPath, crossfadeMs }) {
  const fadeSec = crossfadeMs / 1000;

  // Get durations of all clips
  const durations = [];
  for (const p of inputPaths) {
    durations.push(await getDuration(p));
  }

  console.log(`  [stitch] Concatenating ${inputPaths.length} scenes with ${crossfadeMs}ms crossfade...`);

  // Build FFmpeg filter chain for xfade
  // For N clips, we need N-1 xfade filters chained
  const inputs = inputPaths.flatMap((p, i) => ['-i', p]);

  let filterComplex = '';
  let prevLabel = '0:v';
  let prevALabel = '0:a';
  let offset = durations[0] - fadeSec;

  for (let i = 1; i < inputPaths.length; i++) {
    const outLabel = i < inputPaths.length - 1 ? `v${i}` : 'vout';
    const outALabel = i < inputPaths.length - 1 ? `a${i}` : 'aout';

    filterComplex += `[${prevLabel}][${i}:v]xfade=transition=fade:duration=${fadeSec}:offset=${offset.toFixed(3)}[${outLabel}];`;
    filterComplex += `[${prevALabel}][${i}:a]acrossfade=d=${fadeSec}[${outALabel}];`;

    prevLabel = outLabel;
    prevALabel = outALabel;

    if (i < inputPaths.length - 1) {
      offset += durations[i] - fadeSec;
    }
  }

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '[aout]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
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
    // Crossfade failed — fall back to hard cut
    console.error(`  [stitch] Crossfade failed, falling back to hard cut: ${err.message}`);
    return stitchWithConcat({ inputPaths, outputPath });
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
