/**
 * BullMQ Job Queue — manages pipeline and regen jobs via Redis.
 */

import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { processFullPipeline } from './processors/full-pipeline.js';
import { processRegenScene } from './processors/regen-scene.js';
import { processHumanReview } from './processors/human-review.js';

const QUEUE_NAME = 'video-pipeline';

let connection;
let queue;
let worker;

/**
 * Initialize Redis connection, queue, and worker.
 */
export function initJobStore() {
  connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: { age: config.jobTtlHours * 3600 },
      removeOnFail: { age: config.jobTtlHours * 3600 },
      attempts: 1,
    },
  });

  worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === 'full-pipeline') {
        return processFullPipeline(job);
      }
      if (job.name === 'regen-scene') {
        return processRegenScene(job);
      }
      if (job.name === 'human-review') {
        return processHumanReview(job);
      }
      throw new Error(`Unknown job type: ${job.name}`);
    },
    {
      connection: new IORedis(config.redisUrl, { maxRetriesPerRequest: null }),
      concurrency: config.maxConcurrentJobs,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[queue] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[queue] Job ${job.id} failed: ${err.message}`);
  });

  console.log(`[queue] Worker started (concurrency: ${config.maxConcurrentJobs})`);

  return { queue, worker, connection };
}

/**
 * Add a full pipeline job to the queue.
 * Returns existing job if one is already active with the same key.
 */
export async function addPipelineJob(storyboardPath, options = {}) {
  const jobKey = `pipeline:${storyboardPath}`;

  // Check for existing active job with same key
  const existing = await findActiveJobByKey(jobKey);
  if (existing) {
    return { jobId: existing.id, status: 'active', duplicate: true };
  }

  const job = await queue.add('full-pipeline', {
    storyboardPath,
    options,
    jobKey,
  }, { jobId: randomUUID() });

  return { jobId: job.id, status: 'queued', duplicate: false };
}

/**
 * Add a scene regeneration job to the queue.
 */
export async function addRegenJob({ storyboardPath, scenes, skipTTS, skipAvatar }) {
  const scenesSorted = [...scenes].sort().join(',');
  const jobKey = `regen:${storyboardPath}:${scenesSorted}`;

  const existing = await findActiveJobByKey(jobKey);
  if (existing) {
    return { jobId: existing.id, status: 'active', duplicate: true };
  }

  const job = await queue.add('regen-scene', {
    storyboardPath, scenes, skipTTS, skipAvatar, jobKey,
  }, { jobId: randomUUID() });

  return { jobId: job.id, status: 'queued', duplicate: false };
}

/**
 * Add a human review job to the queue.
 */
export async function addHumanReviewJob({ storyboardPath, scene, comment }) {
  const jobKey = `review:${storyboardPath}:${scene}`;

  const existing = await findActiveJobByKey(jobKey);
  if (existing) {
    return { jobId: existing.id, status: 'active', duplicate: true };
  }

  const job = await queue.add('human-review', {
    storyboardPath, scene, comment, jobKey,
  }, { jobId: randomUUID() });

  return { jobId: job.id, status: 'queued', duplicate: false };
}

/**
 * Get job status by ID.
 */
export async function getJobStatus(jobId) {
  const job = await Job_getById(jobId);
  if (!job) return null;

  const state = await job.getState();
  const progress = job.progress || '';

  const result = {
    jobId: job.id,
    status: state === 'waiting' ? 'queued' : state,
    progress: typeof progress === 'string' ? progress : '',
    createdAt: new Date(job.timestamp).toISOString(),
    result: null,
    error: null,
  };

  if (state === 'completed' && job.returnvalue) {
    result.result = job.returnvalue;
  }

  if (state === 'failed') {
    result.error = job.failedReason || 'Unknown error';
  }

  return result;
}

/**
 * Get queue health stats.
 */
export async function getQueueStats() {
  const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed');
  return {
    waiting: counts.waiting || 0,
    active: counts.active || 0,
    completed: counts.completed || 0,
    failed: counts.failed || 0,
  };
}

/**
 * Helper: get a job by ID using the queue.
 */
async function Job_getById(jobId) {
  try {
    const { Job } = await import('bullmq');
    return await Job.fromId(queue, jobId);
  } catch {
    return null;
  }
}

/**
 * Find an active/waiting job with the same jobKey to prevent duplicates.
 */
async function findActiveJobByKey(jobKey) {
  const active = await queue.getJobs(['active', 'waiting']);
  return active.find(j => j.data?.jobKey === jobKey) || null;
}

/**
 * Graceful shutdown.
 */
export async function closeJobStore() {
  if (worker) await worker.close();
  if (queue) await queue.close();
  if (connection) await connection.quit();
}
