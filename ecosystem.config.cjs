module.exports = {
  apps: [{
    name: 'vcf-api',
    script: 'scripts/start-server.js',
    cwd: '/opt/vcf',
    instances: 1,
    max_memory_restart: '4G',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
