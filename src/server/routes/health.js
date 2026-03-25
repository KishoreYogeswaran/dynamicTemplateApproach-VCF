/**
 * Health check route — queue depth, active workers, memory usage.
 */

import { getQueueStats } from '../queue/job-store.js';

export async function healthRoutes(fastify) {
  fastify.get('/health', async () => {
    const stats = await getQueueStats();
    const mem = process.memoryUsage();

    return {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      queue: stats,
      memory: {
        rss: `${(mem.rss / 1024 / 1024).toFixed(0)}MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`,
      },
    };
  });
}
