#!/usr/bin/env node
/**
 * Run the full video pipeline: Storyboard JSON → TTS → Avatar → HTML → Record → Stitch → Final MP4
 *
 * Usage:
 *   node scripts/run-pipeline.js --module 2 --lesson 3 --ml 3
 *   node scripts/run-pipeline.js --module 2 --lesson 3 --ml 3 --language en
 *   node scripts/run-pipeline.js --module 2 --lesson 3 --ml 3 --scene SC3
 *   node scripts/run-pipeline.js --module 2 --lesson 3 --ml 3 --skip-tts --skip-avatar
 *   node scripts/run-pipeline.js sample/M2_L3_ML3.json          # legacy: direct path
 */

import '../src/utils/env.js';
import { runPipeline } from '../src/pipeline/orchestrator.js';
import { resolve } from 'path';
import { exec } from 'child_process';
import { existsSync } from 'fs';

const args = process.argv.slice(2);

function getFlag(flag) {
  return args.includes(flag);
}

function getFlagValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

// Resolve storyboard path from flags or positional argument
let storyboardPath = args.find(a => !a.startsWith('--') && a.endsWith('.json'));

if (!storyboardPath) {
  const module = getFlagValue('--module');
  const lesson = getFlagValue('--lesson');
  const ml = getFlagValue('--ml');
  const language = getFlagValue('--language') || 'en';

  if (module && lesson && ml) {
    // Pattern: sample/8.2_media_prompts_{lang}_M{module}_L{lesson}_ML{ml}.json
    storyboardPath = `sample/8.2_media_prompts_${language}_M${module}_L${lesson}_ML${ml}.json`;
    console.log(`[cli] Resolved storyboard: ${storyboardPath}`);

    if (!existsSync(storyboardPath)) {
      console.error(`[cli] File not found: ${storyboardPath}`);
      process.exit(1);
    }
  }
}

if (!storyboardPath) {
  console.log(`
Usage:
  node scripts/run-pipeline.js --module 2 --lesson 3 --ml 3 [--language en]
  node scripts/run-pipeline.js <storyboard.json>

Flags:
  --module <n>       Module number (required if no JSON path given)
  --lesson <n>       Lesson number (required if no JSON path given)
  --ml <n>           Micro-lesson number (required if no JSON path given)
  --language <code>  Language code (default: en)

Options:
  --scene <id>       Only process scenes matching this ID substring
  --concurrency <n>  Max concurrent LLM calls (default: 3)
  --skip-tts         Skip TTS audio generation
  --skip-avatar      Skip avatar video generation
  --skip-record      Skip Puppeteer recording (HTML only)
  --skip-stitch      Skip FFmpeg stitching (individual scene MP4s only)
  --stitch-only      Only stitch existing scene MP4s (skip TTS, avatar, HTML, recording)
  --fps <n>          Recording frames per second (default: 24)
  --crossfade <ms>   Crossfade between scenes in ms (default: 0, i.e. hard cut)
  --gap <ms>         Black gap between scenes in ms (default: 700)
  --theme <name>     Override theme (e.g., "dark_blue")
  --output <dir>     Output directory (default: outputs)
  --open             Open final video after completion
`);
  process.exit(1);
}

const startTime = Date.now();

const stitchOnly = getFlag('--stitch-only');

const result = await runPipeline(storyboardPath, {
  outputDir: resolve(getFlagValue('--output') || 'outputs'),
  concurrency: parseInt(getFlagValue('--concurrency') || '3', 10),
  sceneFilter: getFlagValue('--scene') || null,
  skipTTS: stitchOnly || getFlag('--skip-tts'),
  skipAvatar: stitchOnly || getFlag('--skip-avatar'),
  skipRecord: stitchOnly || getFlag('--skip-record'),
  skipStitch: getFlag('--skip-stitch'),
  stitchOnly,
  fps: parseInt(getFlagValue('--fps') || '24', 10),
  crossfadeMs: parseInt(getFlagValue('--crossfade') ?? '0', 10),
  gapMs: parseInt(getFlagValue('--gap') ?? '700', 10),
  themeOverride: getFlagValue('--theme') || null,
});

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`Total time: ${elapsed}s`);

if (getFlag('--open')) {
  const filePath = result.finalVideo?.outputPath
    || result.recordings?.[0]?.outputPath
    || result.scenes?.[0]?.htmlPath;

  if (filePath) {
    exec(`open "${filePath}"`);
    console.log(`Opening ${filePath}...`);
  }
}
