/**
 * Job routes — submit, poll, and download pipeline jobs.
 */

import { resolve } from 'path';
import { stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { addPipelineJob, addRegenJob, addHumanReviewJob, getJobStatus } from '../queue/job-store.js';
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
        required: ['storyboard', 'scenes'],
        properties: {
          storyboard: { type: 'object' },
          scenes: { type: 'array', items: { type: 'string' }, minItems: 1 },
          skipTTS: { type: 'boolean', default: true },
          skipAvatar: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    const { storyboard, scenes, skipTTS = true, skipAvatar = true } = request.body;

    // Write storyboard to a temp file
    const { writeFile, mkdir } = await import('fs/promises');
    const { randomUUID } = await import('crypto');

    const tmpDir = resolve('tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = resolve(tmpDir, `storyboard_${randomUUID()}.json`);
    await writeFile(tmpPath, JSON.stringify(storyboard), 'utf-8');

    const result = await addRegenJob({
      storyboardPath: tmpPath, scenes, skipTTS, skipAvatar,
    });

    const statusCode = result.duplicate ? 409 : 201;
    return reply.code(statusCode).send({
      jobId: result.jobId,
      status: result.status,
      ...(result.duplicate ? { message: 'A regen job for these scenes is already in progress' } : {}),
    });
  });

  // ─── POST /api/jobs/human-review — Re-generate scene with reviewer feedback ──
  fastify.post('/api/jobs/human-review', {
    schema: {
      body: {
        type: 'object',
        required: ['storyboard', 'scene', 'comment'],
        properties: {
          storyboard: { type: 'object' },
          scene: { type: 'string' },
          comment: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { storyboard, scene, comment } = request.body;

    // Write storyboard to a temp file
    const { writeFile, mkdir } = await import('fs/promises');
    const { randomUUID } = await import('crypto');

    const tmpDir = resolve('tmp');
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = resolve(tmpDir, `storyboard_${randomUUID()}.json`);
    await writeFile(tmpPath, JSON.stringify(storyboard), 'utf-8');

    const result = await addHumanReviewJob({
      storyboardPath: tmpPath, scene, comment,
    });

    const statusCode = result.duplicate ? 409 : 201;
    return reply.code(statusCode).send({
      jobId: result.jobId,
      status: result.status,
      ...(result.duplicate ? { message: 'A review job for this scene is already in progress' } : {}),
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

  // ─── GET /api/jobs/:jobId/video?scene=SC12 — Download scene MP4 ──────────
  fastify.get('/api/jobs/:jobId/video', async (request, reply) => {
    const { jobId } = request.params;
    const sceneFilter = request.query.scene || null;

    const status = await getJobStatus(jobId);
    if (!status) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    if (status.status !== 'completed') {
      return reply.code(400).send({
        error: `Job is not complete (status: ${status.status})`,
      });
    }

    const scenes = status.result?.scenes;

    if (!scenes || scenes.length === 0) {
      return reply.code(500).send({ error: 'Job completed but no scene videos in result' });
    }

    // If no scene specified and only one scene, return it directly
    // If no scene specified and multiple scenes, return the scene list
    if (!sceneFilter) {
      if (scenes.length === 1) {
        return sendVideo(reply, scenes[0].videoPath, scenes[0].fileName);
      }
      return reply.code(400).send({
        error: 'Multiple scenes available. Specify ?scene=<sceneId> to download.',
        scenes: scenes.map(s => s.sceneId),
      });
    }

    // Find the requested scene
    const match = scenes.find(s => s.sceneId.includes(sceneFilter));
    if (!match) {
      return reply.code(404).send({
        error: `Scene "${sceneFilter}" not found in job results`,
        availableScenes: scenes.map(s => s.sceneId),
      });
    }

    return sendVideo(reply, match.videoPath, match.fileName);
  });

  async function sendVideo(reply, videoPath, fileName) {
    try {
      const fileStat = await stat(videoPath);
      reply.header('Content-Type', 'video/mp4');
      reply.header('Content-Disposition', `attachment; filename="${fileName || 'video.mp4'}"`);
      reply.header('Content-Length', fileStat.size);
      return reply.send(createReadStream(videoPath));
    } catch {
      return reply.code(404).send({ error: 'Video file not found on disk' });
    }
  }
}
