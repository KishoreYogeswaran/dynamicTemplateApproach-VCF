/**
 * VCF API Server — Entry Point
 *
 * Loads environment variables and starts the Fastify server.
 *
 * Usage:
 *   node scripts/start-server.js
 *   NODE_ENV=production node scripts/start-server.js
 */

import 'dotenv/config';
import { startServer } from '../src/server/index.js';

startServer().catch((err) => {
  console.error('Failed to start VCF API server:', err);
  process.exit(1);
});
