/**
 * Scene Regeneration Job Processor
 *
 * Regenerates specific scenes (new HTML + record) then re-stitches ALL scenes.
 *
 * Flow:
 * 1. For each scene in the array, run pipeline with sceneFilter + skipStitch
 * 2. Run a final stitchOnly pass (no filter) to stitch ALL scene MP4s
 */

import { resolve } from 'path';
import { runPipeline } from '../../../pipeline/orchestrator.js';
import { config } from '../../config.js';

/**
 * Process a scene regeneration job.
 *
 * @param {import('bullmq').Job} job
 * @returns {Promise<{ videoPath: string, fileName: string }>}
 */
export async function processRegenScene(job) {
  const {
    module: mod,
    lesson,
    ml,
    language = 'en',
    scenes = [],
    skipTTS = true,
    skipAvatar = true,
  } = job.data;

  const storyboardPath = resolve(
    config.sampleDir,
    `8.2_media_prompts_${language}_M${mod}_L${lesson}_ML${ml}.json`,
  );

  // Step 1: Regenerate each scene (HTML + record, skip stitch)
  for (let i = 0; i < scenes.length; i++) {
    const sceneId = scenes[i];
    await job.updateProgress(`Regenerating ${sceneId} (${i + 1}/${scenes.length})`);

    await runPipeline(storyboardPath, {
      outputDir: resolve('outputs'),
      concurrency: 1,
      sceneFilter: sceneId,
      skipTTS,
      skipAvatar,
      skipHTML: false,
      skipRecord: false,
      skipStitch: true,          // Don't stitch yet — we stitch ALL scenes at the end
      fps: config.defaultFps,
      gapMs: config.defaultGapMs,
    });
  }

  // Step 2: Re-stitch ALL scene MP4s into the final video
  await job.updateProgress('Re-stitching all scenes...');

  const result = await runPipeline(storyboardPath, {
    outputDir: resolve('outputs'),
    stitchOnly: true,
    gapMs: config.defaultGapMs,
  });

  if (!result.finalVideo?.success) {
    throw new Error(result.finalVideo?.error || 'Re-stitch failed — no final video produced');
  }

  await job.updateProgress('Complete');

  const videoPath = result.finalVideo.outputPath;
  const fileName = videoPath.split('/').pop();

  return { videoPath, fileName };
}
