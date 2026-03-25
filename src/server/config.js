/**
 * Server configuration — all values from environment variables with sensible defaults.
 */

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',

  // Redis
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

  // Job queue
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '5', 10),
  sceneConcurrency: parseInt(process.env.SCENE_CONCURRENCY || '3', 10),
  jobTtlHours: parseInt(process.env.JOB_TTL_HOURS || '24', 10),

  // Pipeline defaults
  defaultFps: 24,
  defaultGapMs: 700,

  // Storyboard sample directory
  sampleDir: process.env.SAMPLE_DIR || 'sample',
};
