/**
 * Human Review Job Processor
 *
 * Re-generates a single scene based on human reviewer feedback.
 * Returns the individual scene MP4 — stitching is handled by the caller.
 */

import { resolve } from 'path';
import { runPipeline } from '../../../pipeline/orchestrator.js';
import { config } from '../../config.js';

/**
 * Process a human review job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<{ scenes: Array<{ sceneId, videoPath, fileName }> }>}
 */
export async function processHumanReview(job) {
  const {
    storyboardPath,
    scene,
    comment,
  } = job.data;

  await job.updateProgress(`Applying review feedback to ${scene}`);

  const result = await runPipeline(storyboardPath, {
    outputDir: resolve('outputs'),
    concurrency: 1,
    sceneFilter: scene,
    humanComment: comment,
    skipTTS: true,
    skipAvatar: true,
    skipHTML: false,
    skipRecord: false,
    skipStitch: true,
    fps: config.defaultFps,
    gapMs: config.defaultGapMs,
  });

  const completedScenes = (result.recordings || [])
    .filter(r => r.recordSuccess && r.videoPath)
    .map(r => ({
      sceneId: r.sceneId,
      videoPath: r.videoPath,
      fileName: r.videoPath.split('/').pop(),
    }));

  if (completedScenes.length === 0) {
    throw new Error('Human review completed but no scene video was produced');
  }

  await job.updateProgress('Complete');

  return { scenes: completedScenes };
}
