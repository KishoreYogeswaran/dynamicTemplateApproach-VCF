#!/usr/bin/env node
/**
 * Preview script — renders scenes from a storyboard JSON into HTML files
 * using Gemini LLM to generate the HTML/CSS/JS for each scene.
 *
 * Usage:
 *   node scripts/preview.js sample/M2_L3_ML3.json
 *   node scripts/preview.js sample/M2_L3_ML3.json --scene SC3
 *   node scripts/preview.js sample/M2_L3_ML3.json --open
 *   node scripts/preview.js sample/M2_L3_ML3.json --concurrency 3
 */

import '../src/utils/env.js'; // Load .env
import { parseStoryboard } from '../src/utils/storyboard-parser.js';
import { renderAllScenesWithLLM } from '../src/pipeline/llm-html-renderer.js';
import { join, resolve } from 'path';
import { exec } from 'child_process';

const args = process.argv.slice(2);
const storyboardPath = args.find(a => !a.startsWith('--'));
const sceneFilter = args.includes('--scene') ? args[args.indexOf('--scene') + 1] : null;
const shouldOpen = args.includes('--open');
const concurrency = args.includes('--concurrency')
  ? parseInt(args[args.indexOf('--concurrency') + 1], 10)
  : 5;

if (!storyboardPath) {
  console.log('Usage: node scripts/preview.js <storyboard.json> [--scene SC3] [--open] [--concurrency N]');
  process.exit(1);
}

const storyboard = await parseStoryboard(resolve(storyboardPath));
const outputDir = resolve('output/preview/html');

const scenesToRender = sceneFilter
  ? storyboard.scenes.filter(s => s.sceneId.includes(sceneFilter))
  : storyboard.scenes;

if (scenesToRender.length === 0) {
  console.log(`No scenes matching "${sceneFilter}".`);
  process.exit(1);
}

console.log(`Storyboard: ${storyboard.mlTitle} (${scenesToRender.length} scenes)`);
console.log(`Domain: ${storyboard.domainKey} | Language: ${storyboard.language}`);
console.log(`Output: ${outputDir}\n`);

const startTime = Date.now();

const filteredStoryboard = { ...storyboard, scenes: scenesToRender };
const results = await renderAllScenesWithLLM(filteredStoryboard, { outputDir, concurrency });
for (const r of results) {
  console.log(`  ✓ ${r.sceneId} → ${r.path}`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n${scenesToRender.length} scene(s) rendered in ${elapsed}s.`);

if (shouldOpen) {
  const filePath = join(outputDir, `${scenesToRender[0].sceneId}.html`);
  exec(`open "${filePath}"`);
  console.log(`Opening ${scenesToRender[0].sceneId} in browser...`);
}
