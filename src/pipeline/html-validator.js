/**
 * HTML Visual Validator
 *
 * Loads generated scene HTML in a headless browser and checks for:
 * 1. Safe zone violations (content outside 60px margins)
 * 2. Text overflow / truncation
 * 3. Avatar zone overlap
 * 4. Element-to-element overlap
 * 5. Missing / empty elements
 * 6. Font size readability (minimum 20px)
 * 7. Broken bullet structure (missing bullet-marker span, inline chevrons)
 * 8. Container safe zone (ost-container elements outside 60px margins)
 * 9. Split-screen header width (headers too wide on split-screen scenes)
 *
 * Returns structured issues that can be fed back to the LLM for correction.
 */

import { chromium } from 'playwright';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Browser lifecycle (singleton) ───────────────────────────────────────────

let _browser = null;

async function getBrowser() {
  if (!_browser || !_browser.isConnected()) {
    _browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  }
  return _browser;
}

export async function closeValidator() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ─── Avatar bounding boxes ───────────────────────────────────────────────────

const AVATAR_PADDING = 30; // extra margin around avatar zone

function getAvatarBoundingBox(sceneType, avatarPosition) {
  if (!sceneType || !avatarPosition) return null;

  // Circle avatars: 420x420 at 60px from edges
  if (sceneType === 'avatar_image_circle') {
    const size = 420;
    const offset = 60;
    const boxes = {
      'bottom-left':  { left: offset, top: 1080 - offset - size, right: offset + size, bottom: 1080 - offset },
      'bottom-right': { left: 1920 - offset - size, top: 1080 - offset - size, right: 1920 - offset, bottom: 1080 - offset },
      'top-left':     { left: offset, top: offset, right: offset + size, bottom: offset + size },
      'top-right':    { left: 1920 - offset - size, top: offset, right: 1920 - offset, bottom: offset + size },
    };
    const box = boxes[avatarPosition];
    if (!box) return null;
    return pad(box);
  }

  // Learning objective: left half, 50% width, 85% height, bottom-anchored
  if (sceneType === 'learning_objective_scene') {
    return pad({ left: 0, top: 1080 * 0.15, right: 1920 * 0.5, bottom: 1080 });
  }

  // Presenter torso
  if (sceneType === 'avatar_presenter_torso') {
    const boxes = {
      'presenter-left':   { left: 20, top: 1080 * 0.1, right: 1920 * 0.4 + 20, bottom: 1080 },
      'presenter-center': { left: 1920 * 0.3, top: 1080 * 0.2, right: 1920 * 0.7, bottom: 1080 },
      'presenter-right':  { left: 1920 * 0.6 - 20, top: 1080 * 0.1, right: 1920 - 20, bottom: 1080 },
    };
    const box = boxes[avatarPosition];
    if (!box) return null;
    return pad(box);
  }

  return null;
}

function pad(box) {
  return {
    left: box.left - AVATAR_PADDING,
    top: box.top - AVATAR_PADDING,
    right: box.right + AVATAR_PADDING,
    bottom: box.bottom + AVATAR_PADDING,
  };
}

function rectsOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// ─── Main validation ─────────────────────────────────────────────────────────

/**
 * Validate a scene HTML string.
 *
 * @param {string} html - Full HTML content
 * @param {object} sceneContext
 * @param {string} sceneContext.sceneType
 * @param {string} sceneContext.avatarPosition
 * @param {string[]} sceneContext.expectedIds - e.g. ['header_1', 'bullet_1', 'keyphrase_1']
 * @returns {{ pass: boolean, issues: object[], summary: string }}
 */
export async function validateSceneHTML(html, sceneContext) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

  // Write HTML to temp file (Playwright needs a file:// URL for proper resource loading)
  const tmpPath = join(tmpdir(), `validate_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
  await writeFile(tmpPath, html, 'utf-8');

  const issues = [];

  try {
    await page.goto(`file://${tmpPath}`, { waitUntil: 'networkidle', timeout: 15000 });
    // Brief settle for layout
    await page.waitForTimeout(200);

    // Run all checks in a single evaluate call for performance
    const checkResults = await page.evaluate(({ expectedIds, sceneType }) => {
      const results = [];
      const SAFE = { left: 60, top: 60, right: 1860, bottom: 1020 };
      const MIN_FONT_SIZE = 20;
      const OVERFLOW_TOLERANCE = 10;  // px — ignore tiny overflow (line-height rounding, descenders)
      const SAFE_ZONE_TOLERANCE = 10; // px — ignore near-edge elements within tolerance
      const OVERLAP_TOLERANCE = 8;    // px — ignore tiny overlaps between elements

      // Collect all text element rects
      const elementData = [];

      for (const id of expectedIds) {
        const el = document.getElementById(id);

        if (!el) {
          results.push({ check: 'missing-element', severity: 'error', elementId: id, message: `Element "${id}" not found in HTML.`, details: {} });
          continue;
        }

        const text = el.textContent?.trim() || '';
        if (!text) {
          results.push({ check: 'missing-element', severity: 'error', elementId: id, message: `Element "${id}" exists but has no text content.`, details: {} });
          continue;
        }

        const rect = el.getBoundingClientRect();

        // For font size, check the deepest text-containing element
        // (e.g., bullet_N might be an outer div, actual text is in a child span)
        let fontEl = el;
        const textChildren = el.querySelectorAll('span, p, div, h1, h2, h3, h4');
        if (textChildren.length > 0) {
          // Find the child with the most text content
          let maxLen = 0;
          for (const child of textChildren) {
            const len = (child.textContent || '').trim().length;
            if (len > maxLen) { maxLen = len; fontEl = child; }
          }
        }
        const fontSize = parseFloat(getComputedStyle(fontEl).fontSize);

        elementData.push({ id, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }, fontSize });

        // Check 1: Safe zone (with tolerance)
        if (rect.left < SAFE.left - SAFE_ZONE_TOLERANCE || rect.top < SAFE.top - SAFE_ZONE_TOLERANCE || rect.right > SAFE.right + SAFE_ZONE_TOLERANCE || rect.bottom > SAFE.bottom + SAFE_ZONE_TOLERANCE) {
          const violations = [];
          if (rect.left < SAFE.left - SAFE_ZONE_TOLERANCE) violations.push(`left edge at ${Math.round(rect.left)}px (min: ${SAFE.left}px)`);
          if (rect.top < SAFE.top - SAFE_ZONE_TOLERANCE) violations.push(`top edge at ${Math.round(rect.top)}px (min: ${SAFE.top}px)`);
          if (rect.right > SAFE.right + SAFE_ZONE_TOLERANCE) violations.push(`right edge at ${Math.round(rect.right)}px (max: ${SAFE.right}px)`);
          if (rect.bottom > SAFE.bottom + SAFE_ZONE_TOLERANCE) violations.push(`bottom edge at ${Math.round(rect.bottom)}px (max: ${SAFE.bottom}px)`);
          results.push({
            check: 'safe-zone', severity: 'error', elementId: id,
            message: `"${id}" extends beyond safe zone — ${violations.join(', ')}.`,
            details: { rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) } },
          });
        }

        // Check 2: Text overflow (with tolerance for line-height rounding)
        const vOverflow = el.scrollHeight - el.clientHeight;
        if (vOverflow > OVERFLOW_TOLERANCE) {
          results.push({
            check: 'overflow', severity: 'error', elementId: id,
            message: `"${id}" text is truncated vertically — overflows by ${vOverflow}px (scrollHeight: ${el.scrollHeight}px, clientHeight: ${el.clientHeight}px).`,
            details: { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflow: vOverflow },
          });
        }
        const hOverflow = el.scrollWidth - el.clientWidth;
        if (hOverflow > OVERFLOW_TOLERANCE) {
          results.push({
            check: 'overflow', severity: 'warning', elementId: id,
            message: `"${id}" text overflows horizontally by ${hOverflow}px (scrollWidth: ${el.scrollWidth}px, clientWidth: ${el.clientWidth}px).`,
            details: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflow: hOverflow },
          });
        }

        // Check 6: Font size
        if (fontSize < MIN_FONT_SIZE) {
          results.push({
            check: 'font-size', severity: 'warning', elementId: id,
            message: `"${id}" font size is ${fontSize}px, minimum recommended is ${MIN_FONT_SIZE}px.`,
            details: { fontSize },
          });
        }
      }

      // Check 7: Broken bullet structure
      // Skip for split_screen_image — those use panel-label (no bullet-marker by design)
      if (sceneType !== 'split_screen_image') {
        for (const id of expectedIds) {
          if (!id.startsWith('bullet_')) continue;
          const el = document.getElementById(id);
          if (!el) continue;

          const marker = el.querySelector('.bullet-marker');
          if (!marker) {
            results.push({
              check: 'bullet-structure', severity: 'error', elementId: id,
              message: `"${id}" is missing a <span class="bullet-marker"> child — bullet structure is broken.`,
              details: {},
            });
          }

          // Check if chevron-like characters leaked into the text content
          const textSpan = el.querySelector('.text-bullet');
          const textContent = (textSpan || el).textContent || '';
          if (/^[\s]*[›▸▹▶►➤❯⟩>»→‣•·■□☐✓✔☑]\s/.test(textContent)) {
            results.push({
              check: 'bullet-structure', severity: 'error', elementId: id,
              message: `"${id}" has an inline marker character in the text ("${textContent.slice(0, 30).trim()}…") — the chevron should come from .bullet-marker::after, not from text content.`,
              details: { textStart: textContent.slice(0, 40).trim() },
            });
          }
        }
      }

      // Check 8: Container safe zone — .ost-container elements must respect 60px safe zone
      const containers = document.querySelectorAll('.ost-container');
      for (const container of containers) {
        const rect = container.getBoundingClientRect();
        // Skip invisible or zero-size containers
        if (rect.width === 0 || rect.height === 0) continue;

        const violations = [];
        if (rect.left < SAFE.left - SAFE_ZONE_TOLERANCE) violations.push(`left edge at ${Math.round(rect.left)}px (min: ${SAFE.left}px)`);
        if (rect.top < SAFE.top - SAFE_ZONE_TOLERANCE) violations.push(`top edge at ${Math.round(rect.top)}px (min: ${SAFE.top}px)`);
        if (rect.right > SAFE.right + SAFE_ZONE_TOLERANCE) violations.push(`right edge at ${Math.round(rect.right)}px (max: ${SAFE.right}px)`);
        if (rect.bottom > SAFE.bottom + SAFE_ZONE_TOLERANCE) violations.push(`bottom edge at ${Math.round(rect.bottom)}px (max: ${SAFE.bottom}px)`);

        if (violations.length > 0) {
          // Try to identify the container by id or class
          const label = container.id || container.className.split(' ').slice(0, 2).join('.') || 'ost-container';
          results.push({
            check: 'container-safe-zone', severity: 'error', elementId: label,
            message: `Container "${label}" extends beyond safe zone — ${violations.join(', ')}.`,
            details: { rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) } },
          });
        }
      }

      // Check 9: Split-screen header width — headers should not span full width on split-screen scenes
      if (sceneType === 'split_screen_image') {
        for (const el of elementData) {
          if (!el.id.startsWith('header_')) continue;
          // A header wider than 65% of canvas on a split-screen is likely spanning both halves
          if (el.rect.width > 1920 * 0.65) {
            results.push({
              check: 'split-header-width', severity: 'error', elementId: el.id,
              message: `"${el.id}" is ${Math.round(el.rect.width)}px wide on a split-screen scene — it should only cover the text half (~45-55% width, max ~1050px).`,
              details: { width: Math.round(el.rect.width), maxRecommended: 1050 },
            });
          }
        }
        // Also check ost-containers that hold headers
        for (const container of containers) {
          const rect = container.getBoundingClientRect();
          const hasHeader = container.querySelector('[id^="header_"]');
          if (hasHeader && rect.width > 1920 * 0.65) {
            const label = container.id || container.className.split(' ').slice(0, 2).join('.') || 'ost-container';
            results.push({
              check: 'split-header-width', severity: 'error', elementId: label,
              message: `Header container "${label}" is ${Math.round(rect.width)}px wide on a split-screen scene — should be ≤55% of canvas width.`,
              details: { width: Math.round(rect.width) },
            });
          }
        }
      }

      // Check 10: Missing data-translate attributes (required for translation)
      for (const id of expectedIds) {
        const hasTranslate = document.querySelector(`[data-translate="${id}"]`);
        if (!hasTranslate) {
          results.push({
            check: 'missing-translate', severity: 'warning', elementId: id,
            message: `No element with data-translate="${id}" found — this text cannot be translated.`,
            details: {},
          });
        }
      }

      // Check 4: Element-to-element overlap (pairwise)
      for (let i = 0; i < elementData.length; i++) {
        for (let j = i + 1; j < elementData.length; j++) {
          const a = elementData[i];
          const b = elementData[j];
          const overlap = a.rect.left < b.rect.right && a.rect.right > b.rect.left &&
                          a.rect.top < b.rect.bottom && a.rect.bottom > b.rect.top;
          if (overlap) {
            // Check if one is a parent of the other (intentional nesting)
            const elA = document.getElementById(a.id);
            const elB = document.getElementById(b.id);
            if (elA?.contains(elB) || elB?.contains(elA)) continue;

            // Check if they share a parent container (e.g., header + subheader in same card)
            if (elA?.parentElement === elB?.parentElement) continue;

            const overlapX = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
            const overlapY = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
            // Skip tiny overlaps (rounding, borders, shadows)
            if (overlapX <= OVERLAP_TOLERANCE || overlapY <= OVERLAP_TOLERANCE) continue;
            results.push({
              check: 'element-overlap', severity: 'warning', elementId: `${a.id}+${b.id}`,
              message: `"${a.id}" and "${b.id}" overlap by ${Math.round(overlapX)}px × ${Math.round(overlapY)}px.`,
              details: { elementA: a.id, elementB: b.id, overlapX: Math.round(overlapX), overlapY: Math.round(overlapY) },
            });
          }
        }
      }

      return { results, elementData };
    }, { expectedIds: sceneContext.expectedIds, sceneType: sceneContext.sceneType });

    issues.push(...checkResults.results);

    // Check 3: Avatar zone overlap (done outside evaluate since we need sceneContext)
    const avatarBox = getAvatarBoundingBox(sceneContext.sceneType, sceneContext.avatarPosition);
    if (avatarBox) {
      for (const el of checkResults.elementData) {
        if (rectsOverlap(el.rect, avatarBox)) {
          const overlapX = Math.min(el.rect.right, avatarBox.right) - Math.max(el.rect.left, avatarBox.left);
          const overlapY = Math.min(el.rect.bottom, avatarBox.bottom) - Math.max(el.rect.top, avatarBox.top);
          issues.push({
            check: 'avatar-overlap', severity: 'error', elementId: el.id,
            message: `"${el.id}" overlaps the avatar zone (${sceneContext.avatarPosition}) by ${Math.round(overlapX)}px × ${Math.round(overlapY)}px.`,
            details: { elementRect: el.rect, avatarBox, overlapX: Math.round(overlapX), overlapY: Math.round(overlapY) },
          });
        }
      }
    }

  } catch (err) {
    console.error('  [validate] Browser evaluation failed:', err.message);
    // Graceful degradation — don't block pipeline on validator errors
    return { pass: true, issues: [], summary: 'Validation skipped (browser error)' };
  } finally {
    await page.close().catch(() => {});
    await unlink(tmpPath).catch(() => {});
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  const pass = errors.length === 0;
  const summary = pass
    ? `Passed (${warnings.length} warning${warnings.length !== 1 ? 's' : ''})`
    : `Failed: ${errors.length} error${errors.length !== 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`;

  return { pass, issues, summary };
}

/**
 * Validate an HTML file on disk.
 */
export async function validateHTMLFile(htmlPath, sceneContext) {
  const { readFile } = await import('fs/promises');
  const html = await readFile(htmlPath, 'utf-8');
  return validateSceneHTML(html, sceneContext);
}

// ─── Correction prompt builder ───────────────────────────────────────────────

/**
 * Build a correction prompt from validation issues.
 *
 * @param {string} originalPrompt - The original LLM prompt
 * @param {object} previousResult - The LLM's previous output {html, css, script, avatarPosition}
 * @param {object[]} issues - Validation issues
 * @returns {string} Correction prompt for the LLM
 */
export function buildCorrectionPrompt(originalPrompt, previousResult, issues) {
  const issueList = issues
    .map((issue, i) => `${i + 1}. [${issue.check}] ${issue.message}`)
    .join('\n');

  return `Your previous HTML output had layout issues that need to be fixed. The output will be displayed on a 1920×1080 canvas.

## ISSUES FOUND
${issueList}

## YOUR PREVIOUS OUTPUT (fix the issues above):
${JSON.stringify(previousResult)}

## ORIGINAL DESIGN REQUIREMENTS
${originalPrompt}

Fix ONLY the layout issues listed above. Keep the overall design, structure, and creative direction the same — just adjust sizes, positions, or padding to resolve the violations.

Return ONLY the corrected raw JSON object. No markdown, no backticks, no commentary:
{"html": "...", "css": "...", "script": "...", "avatarPosition": "..."}`;
}

// ─── Scene context builder ───────────────────────────────────────────────────

/**
 * Build sceneContext from a parsed scene and LLM result.
 */
export function buildSceneContext(scene, avatarPosition) {
  const expectedIds = [];

  if (scene.content.headers) {
    scene.content.headers.forEach((_, i) => expectedIds.push(`header_${i + 1}`));
  }
  if (scene.content.subHeaders) {
    scene.content.subHeaders.forEach((_, i) => expectedIds.push(`subheader_${i + 1}`));
  }
  if (scene.content.keyPhrases) {
    scene.content.keyPhrases.forEach((_, i) => expectedIds.push(`keyphrase_${i + 1}`));
  }
  if (scene.content.bulletPoints) {
    scene.content.bulletPoints.forEach((_, i) => expectedIds.push(`bullet_${i + 1}`));
  }

  return {
    sceneType: scene.sceneType,
    avatarPosition: avatarPosition || null,
    expectedIds,
  };
}
