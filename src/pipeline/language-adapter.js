/**
 * Language Adapter
 *
 * Adapts English HTML scenes for other languages by swapping:
 * - Text content (by element ID: header_1, bullet_1, keyphrase_1, etc.)
 * - Audio source (scene-audio)
 * - Avatar source (avatar-video)
 * - Font link tag + CSS variables (--font-primary, --font-heading)
 * - Timing data (const timings = {...})
 * - HTML lang attribute
 *
 * Skips the expensive LLM HTML generation step — reuses the English layout.
 */

import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { join } from 'path';
import { generateFontLinkTag, generateFontCSSVars } from '../utils/font-loader.js';

/**
 * Adapt a single English HTML file for a target language.
 *
 * @param {object} opts
 * @param {string} opts.englishHtmlPath   — path to the English HTML file
 * @param {string} opts.outputPath        — path to write the adapted HTML
 * @param {object} opts.scene             — parsed scene object (target language)
 * @param {string} opts.language          — target language code (e.g., 'hi', 'ta')
 * @param {string} opts.audioUrl          — new TTS audio URL
 * @param {string} opts.avatarVideoUrl    — new avatar video URL (or '' if no avatar)
 * @param {object} opts.timings           — recalculated timing object for target language
 * @returns {string} outputPath
 */
export async function adaptSceneHTML({
  englishHtmlPath,
  outputPath,
  scene,
  language,
  audioUrl,
  avatarVideoUrl,
  timings,
}) {
  let html = await readFile(englishHtmlPath, 'utf-8');

  // 1. Replace HTML lang attribute
  html = html.replace(/<html lang="[^"]*"/, `<html lang="${language}"`);

  // 2. Replace Google Fonts link tag
  const newFontLink = await generateFontLinkTag(language);
  html = html.replace(
    /<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*" rel="stylesheet">/,
    newFontLink,
  );

  // 3. Replace CSS font + size variables
  const newFontVars = await generateFontCSSVars(language);
  // Match the full block of font/size variables (2-7 lines starting with --font-primary through --size-*)
  html = html.replace(
    /--font-primary:\s*'[^']*',\s*sans-serif;[\s\S]*?--font-heading:\s*'[^']*',\s*sans-serif;(?:\s*\n\s*--size-[\w-]+:\s*\d+px;)*/,
    newFontVars,
  );

  // 4. Replace text content by element ID
  //
  // HTML element IDs are always sequential within a scene: header_1, header_2, ...
  // For slideshow slides, each slide's HTML has header_1, keyphrase_1, etc.
  // but the storyboard content may have original indices (header_2 for slide2).
  // So we match by position (1-based), not by the storyboard's original index.
  const { headers, subHeaders, bulletPoints, keyPhrases } = scene.content;

  for (let i = 0; i < headers.length; i++) {
    html = replaceTextById(html, `header_${i + 1}`, headers[i].text);
  }
  for (let i = 0; i < subHeaders.length; i++) {
    html = replaceTextById(html, `subheader_${i + 1}`, subHeaders[i].text);
  }
  for (let i = 0; i < keyPhrases.length; i++) {
    html = replaceTextById(html, `keyphrase_${i + 1}`, keyPhrases[i].text);
  }
  for (let i = 0; i < bulletPoints.length; i++) {
    html = replaceTextById(html, `bullet_${i + 1}`, bulletPoints[i].text);
  }

  // 5. Replace audio source
  if (audioUrl) {
    html = html.replace(
      /(<audio id="scene-audio" src=")[^"]*(")/,
      `$1${escapeForReplace(audioUrl)}$2`,
    );
  }

  // 6. Replace avatar video source
  if (avatarVideoUrl) {
    html = html.replace(
      /(<video id="avatar-video" src=")[^"]*(")/,
      `$1${escapeForReplace(avatarVideoUrl)}$2`,
    );
  }

  // 7. Replace timings JSON
  const timingsJson = JSON.stringify(timings);
  html = html.replace(
    /const timings = \{[^;]*\};/,
    `const timings = ${timingsJson};`,
  );

  // Write adapted HTML
  await mkdir(join(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, html, 'utf-8');

  console.log(`  [adapt] ${scene.sceneId}: ✓ Adapted for ${language} → ${outputPath}`);
  return outputPath;
}

/**
 * Universal text replacement by element ID.
 *
 * Strategy: find the element by its ID, then locate the content text to replace.
 * Handles any HTML structure the LLM might generate:
 *
 *   <h1 id="header_1">text</h1>
 *   <div id="bullet_1"><span class="text-bullet">text</span></div>
 *   <span id="bullet_1">text</span>
 *   <div id="bullet_1"><span class="bullet-marker"></span><span class="text-bullet" style="...">text</span></div>
 *   <div id="bullet_1"><div class="step-marker">01</div><div class="step-card">text</div></div>
 *
 * Key rule: only replace the LAST text node inside the element — markers,
 * numbers, and decorative children are preserved.
 */
function replaceTextById(html, elementId, newText) {
  // Primary: match data-translate attribute (bulletproof approach)
  const translateRegex = new RegExp(
    `(data-translate="${elementId}"[^>]*>)([\\s\\S]*?)(<\\/(?:h[1-6]|div|span|p|li)>)`,
  );
  if (translateRegex.test(html)) {
    return html.replace(translateRegex, `$1${escapeHtml(newText)}$3`);
  }

  // Fallback for older English HTMLs without data-translate:
  // Direct text content: <div id="header_1">text</div>
  const directRegex = new RegExp(
    `(id="${elementId}"[^>]*>)([^<]*)(<\\/(?:h[1-6]|div|span|p|li)>)`,
  );
  if (directRegex.test(html)) {
    return html.replace(directRegex, `$1${escapeHtml(newText)}$3`);
  }

  // Fallback: text-bullet span within 500 chars of the element ID
  const idPos = html.indexOf(`id="${elementId}"`);
  if (idPos === -1) {
    console.warn(`  [adapt] Warning: element "${elementId}" not found in HTML`);
    return html;
  }
  const afterId = html.substring(idPos, idPos + 500);
  const bulletSpanRegex = /(<span class="text-bullet"[^>]*>)([\s\S]*?)(<\/span>)/;
  const bulletMatch = afterId.match(bulletSpanRegex);
  if (bulletMatch) {
    const matchPos = idPos + afterId.indexOf(bulletMatch[0]);
    return html.substring(0, matchPos) + bulletMatch[1] + escapeHtml(newText) + bulletMatch[3] + html.substring(matchPos + bulletMatch[0].length);
  }

  console.warn(`  [adapt] Warning: could not replace text for "${elementId}"`);
  return html;
}

/**
 * Escape HTML special characters in text content.
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape $ in replacement strings to prevent regex substitution.
 */
function escapeForReplace(str) {
  return str.replace(/\$/g, '$$$$');
}

/**
 * Check if English HTML files exist for a given ML.
 *
 * @param {string} englishHtmlDir — path to English HTML directory
 * @param {string[]} sceneIds — list of scene IDs to check
 * @returns {{ exists: boolean, missing: string[] }}
 */
export async function checkEnglishHTMLExists(englishHtmlDir, sceneIds) {
  const missing = [];
  for (const id of sceneIds) {
    try {
      await readFile(join(englishHtmlDir, `${id}.html`), 'utf-8');
    } catch {
      missing.push(id);
    }
  }
  return {
    exists: missing.length === 0,
    missing,
  };
}
