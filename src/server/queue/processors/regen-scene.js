/**
 * Scene Regeneration Job Processor
 *
 * Regenerates specific scenes (new HTML + record).
 * Returns individual scene MP4s — stitching is handled by the caller.
 */

import { resolve } from 'path';
import { runPipeline } from '../../../pipeline/orchestrator.js';
import { config } from '../../config.js';

/**
 * Process a scene regeneration job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<{ scenes: Array<{ sceneId, videoPath, fileName }> }>}
 */
export async function processRegenScene(job) {
  const {
    storyboardPath,
    scenes = [],
    skipTTS = true,
    skipAvatar = true,
  } = job.data;

  const completedScenes = [];

  for (let i = 0; i < scenes.length; i++) {
    const sceneId = scenes[i];
    await job.updateProgress(`Regenerating ${sceneId} (${i + 1}/${scenes.length})`);

    const result = await runPipeline(storyboardPath, {
      outputDir: resolve('outputs'),
      concurrency: 1,
      sceneFilter: sceneId,
      skipTTS,
      skipAvatar,
      skipHTML: false,
      skipRecord: false,
      skipStitch: true,
      fps: config.defaultFps,
      gapMs: config.defaultGapMs,
    });

    const recorded = (result.recordings || [])
      .filter(r => r.recordSuccess && r.videoPath)
      .map(r => ({
        sceneId: r.sceneId,
        videoPath: r.videoPath,
        fileName: r.videoPath.split('/').pop(),
      }));

    completedScenes.push(...recorded);
  }

  if (completedScenes.length === 0) {
    throw new Error('Regeneration completed but no scene videos were produced');
  }

  await job.updateProgress('Complete');

  return { scenes: completedScenes };
}
