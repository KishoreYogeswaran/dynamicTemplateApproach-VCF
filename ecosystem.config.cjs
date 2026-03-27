module.exports = {
  apps: [
    {
      name: 'vcf-api',
      script: 'scripts/start-server.js',
      cwd: '/opt/vcf',
      instances: 1,
      max_memory_restart: '4G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
    {
      name: 'vcf-cleanup',
      script: 'scripts/cleanup.js',
      args: '--run',
      cwd: '/opt/vcf',
      cron_restart: '0 3 * * *',   // Run daily at 3 AM
      autorestart: false,           // Don't restart after completion
      env: {
        VIDEO_TTL_DAYS: 7,
        TMP_TTL_HOURS: 12,
      },
    },
  ],
};
