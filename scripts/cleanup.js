/**
 * Cleanup script — deletes old video files and temp storyboards.
 *
 * What gets deleted:
 *   - outputs/**/video/*.mp4  older than VIDEO_TTL_DAYS (default 7)
 *   - tmp/storyboard_*.json   older than TMP_TTL_HOURS (default 12)
 *
 * What is preserved (needed for regen / human review):
 *   - audio/, html/, avatar/, llm-results/
 *
 * Usage:
 *   node scripts/cleanup.js                  # dry run (just logs)
 *   node scripts/cleanup.js --run            # actually delete
 *   VIDEO_TTL_DAYS=3 node scripts/cleanup.js --run
 */

import { readdir, stat, unlink, rm } from 'fs/promises';
import { join, resolve } from 'path';

const VIDEO_TTL_DAYS = parseInt(process.env.VIDEO_TTL_DAYS || '7', 10);
const TMP_TTL_HOURS = parseInt(process.env.TMP_TTL_HOURS || '12', 10);
const DRY_RUN = !process.argv.includes('--run');

const OUTPUTS_DIR = resolve('outputs');
const TMP_DIR = resolve('tmp');

const now = Date.now();
let totalFiles = 0;
let totalBytes = 0;

async function findVideoDirs(dir) {
  const videoDirs = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'video') {
          videoDirs.push(fullPath);
        } else {
          videoDirs.push(...await findVideoDirs(fullPath));
        }
      }
    }
  } catch {
    // Directory doesn't exist — nothing to clean
  }
  return videoDirs;
}

async function cleanOldFiles(dir, maxAgeMs, pattern = null) {
  try {
    const entries = await readdir(dir);
    for (const name of entries) {
      if (pattern && !pattern.test(name)) continue;

      const filePath = join(dir, name);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) continue;

      const ageMs = now - fileStat.mtimeMs;
      if (ageMs < maxAgeMs) continue;

      const ageDays = (ageMs / 86_400_000).toFixed(1);
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1);

      if (DRY_RUN) {
        console.log(`  [dry-run] Would delete: ${filePath} (${sizeMB}MB, ${ageDays}d old)`);
      } else {
        await unlink(filePath);
        console.log(`  Deleted: ${filePath} (${sizeMB}MB, ${ageDays}d old)`);
      }

      totalFiles++;
      totalBytes += fileStat.size;
    }
  } catch {
    // Directory doesn't exist
  }
}

async function main() {
  console.log(`\n[cleanup] ${DRY_RUN ? 'DRY RUN' : 'LIVE RUN'} — ${new Date().toISOString()}`);
  console.log(`  Video TTL: ${VIDEO_TTL_DAYS} days | Tmp TTL: ${TMP_TTL_HOURS} hours\n`);

  // 1. Clean video MP4s older than VIDEO_TTL_DAYS
  const videoMaxAge = VIDEO_TTL_DAYS * 24 * 60 * 60 * 1000;
  const videoDirs = await findVideoDirs(OUTPUTS_DIR);

  if (videoDirs.length > 0) {
    console.log(`[cleanup] Scanning ${videoDirs.length} video directories...`);
    for (const dir of videoDirs) {
      await cleanOldFiles(dir, videoMaxAge, /\.mp4$/);
    }
  } else {
    console.log('[cleanup] No video directories found.');
  }

  // 2. Clean tmp storyboard files older than TMP_TTL_HOURS
  const tmpMaxAge = TMP_TTL_HOURS * 60 * 60 * 1000;
  console.log(`\n[cleanup] Scanning tmp directory...`);
  await cleanOldFiles(TMP_DIR, tmpMaxAge, /^storyboard_.*\.json$/);

  // Summary
  const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
  console.log(`\n[cleanup] ${DRY_RUN ? 'Would delete' : 'Deleted'}: ${totalFiles} files (${totalMB}MB)\n`);
}

main().catch(err => {
  console.error('[cleanup] Error:', err);
  process.exit(1);
});
