/**
 * Job routes — submit, poll, and download pipeline jobs.
 */

import { resolve } from 'path';
import { stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { addPipelineJob, addRegenJob, getJobStatus } from '../queue/job-store.js';
import { config } from '../config.js';

export async function jobRoutes(fastify) {

  // ─── POST /api/jobs — Submit a full pipeline job ───────────────
  fastify.post('/api/jobs', {
    schema: {
      body: {
        type: 'object',
        required: ['storyboard'],
        properties: {
          storyboard: { type: 'object' },
          options: {
            type: 'object',
            properties: {
              concurrency: { type: 'number' },
              fps: { type: 'number' },
              gapMs: { type: 'number' },
              themeOverride: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { storyboard, options = {} } = request.body;

    // Write storyboard to a temp file and pass the path
    const { writeFile, mkdir } = await import('fs/promises');
    const { randomUUID } = await import('crypto');

    const tmpDir = resolve('tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = resolve(tmpDir, `storyboard_${randomUUID()}.json`);
    await writeFile(tmpPath, JSON.stringify(storyboard), 'utf-8');

    const result = await addPipelineJob(tmpPath, {
      concurrency: options.concurrency || config.sceneConcurrency,
      fps: options.fps || config.defaultFps,
      gapMs: options.gapMs ?? config.defaultGapMs,
      themeOverride: options.themeOverride || null,
    });

    const statusCode = result.duplicate ? 409 : 201;
    return reply.code(statusCode).send({
      jobId: result.jobId,
      status: result.status,
      ...(result.duplicate ? { message: 'A job for this storyboard is already in progress' } : {}),
    });
  });

  // ─── POST /api/jobs/regenerate-scene — Regenerate specific scenes ──
  fastify.post('/api/jobs/regenerate-scene', {
    schema: {
      body: {
        type: 'object',
        required: ['module', 'lesson', 'ml', 'scenes'],
        properties: {
          module: { type: 'number' },
          lesson: { type: 'number' },
          ml: { type: 'number' },
          language: { type: 'string', default: 'en' },
          scenes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          skipTTS: { type: 'boolean', default: true },
          skipAvatar: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    const { module: mod, lesson, ml, language = 'en', scenes, skipTTS = true, skipAvatar = true } = request.body;

    // Verify storyboard file exists
    const storyboardPath = resolve(
      config.sampleDir,
      `8.2_media_prompts_${language}_M${mod}_L${lesson}_ML${ml}.json`,
    );
    try {
      await stat(storyboardPath);
    } catch {
      return reply.code(404).send({
        error: `Storyboard not found: M${mod}_L${lesson}_ML${ml} (${language})`,
      });
    }

    const result = await addRegenJob({
      module: mod, lesson, ml, language, scenes, skipTTS, skipAvatar,
    });

    const statusCode = result.duplicate ? 409 : 201;
    return reply.code(statusCode).send({
      jobId: result.jobId,
      status: result.status,
      ...(result.duplicate ? { message: 'A regen job for these scenes is already in progress' } : {}),
    });
  });

  // ─── GET /api/jobs/:jobId — Poll job status ────────────────────
  fastify.get('/api/jobs/:jobId', async (request, reply) => {
    const { jobId } = request.params;

    const status = await getJobStatus(jobId);
    if (!status) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    return status;
  });

  // ─── GET /api/jobs/:jobId/video — Download final MP4 ──────────
  fastify.get('/api/jobs/:jobId/video', async (request, reply) => {
    const { jobId } = request.params;

    const status = await getJobStatus(jobId);
    if (!status) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    if (status.status !== 'completed') {
      return reply.code(400).send({
        error: `Job is not complete (status: ${status.status})`,
      });
    }

    const videoPath = status.result?.videoPath;
    if (!videoPath) {
      return reply.code(500).send({ error: 'Job completed but no video path in result' });
    }

    try {
      const fileStat = await stat(videoPath);
      const fileName = status.result.fileName || 'video.mp4';

      reply.header('Content-Type', 'video/mp4');
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
      reply.header('Content-Length', fileStat.size);

      return reply.send(createReadStream(videoPath));
    } catch {
      return reply.code(404).send({ error: 'Video file not found on disk' });
    }
  });
}
