/**
 * VCF API Server — Fastify + BullMQ
 *
 * HTTP API for the Video Content Factory pipeline.
 * Jobs are queued in Redis via BullMQ and processed by workers.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { initJobStore, closeJobStore } from './queue/job-store.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
    bodyLimit: 50 * 1024 * 1024, // 50MB — storyboard JSONs can be large
  });

  // CORS for cross-origin Python clients
  await fastify.register(cors, { origin: true });

  // Routes
  await fastify.register(healthRoutes);
  await fastify.register(jobRoutes);

  // Initialize job queue + worker
  initJobStore();

  // Graceful shutdown
  const shutdown = async (signal) => {
    fastify.log.info(`${signal} received — shutting down...`);
    await closeJobStore();
    await fastify.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return fastify;
}

export async function startServer() {
  const fastify = await buildServer();

  await fastify.listen({ port: config.port, host: config.host });
  console.log(`\n  VCF API running on http://${config.host}:${config.port}`);
  console.log(`  Health: http://localhost:${config.port}/health\n`);

  return fastify;
}
