/**
 * Full Pipeline Job Processor
 *
 * Runs the complete pipeline: TTS -> Avatar -> HTML -> Record -> Stitch
 */

import { resolve } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { runPipeline } from '../../../pipeline/orchestrator.js';
import { config } from '../../config.js';

/**
 * Process a full pipeline job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<{ videoPath: string, fileName: string }>}
 */
export async function processFullPipeline(job) {
  const { storyboardPath, options = {} } = job.data;

  await job.updateProgress('Starting pipeline...');

  // If storyboard is inline JSON (not a file path), write it to a temp file
  let resolvedPath = storyboardPath;
  if (typeof storyboardPath === 'object') {
    const tmpDir = resolve('tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = resolve(tmpDir, `storyboard_${randomUUID()}.json`);
    await writeFile(tmpPath, JSON.stringify(storyboardPath), 'utf-8');
    resolvedPath = tmpPath;
  }

  await job.updateProgress('Processing scenes...');

  const result = await runPipeline(resolvedPath, {
    outputDir: resolve('outputs'),
    concurrency: options.concurrency || config.sceneConcurrency,
    fps: options.fps || config.defaultFps,
    gapMs: options.gapMs ?? config.defaultGapMs,
    themeOverride: options.themeOverride || null,
  });

  if (!result.finalVideo?.success) {
    throw new Error(result.finalVideo?.error || 'Pipeline completed but no final video was produced');
  }

  await job.updateProgress('Complete');

  const videoPath = result.finalVideo.outputPath;
  const fileName = videoPath.split('/').pop();

  return { videoPath, fileName };
}
