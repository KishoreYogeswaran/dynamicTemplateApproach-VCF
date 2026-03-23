/**
 * Calculates animation timings for a scene.
 *
 * When word-level alignment data is available (from ElevenLabs TTS),
 * OST elements appear in sync with the voiceover — each element shows up
 * just before the narrator says the corresponding words.
 *
 * Falls back to simple staggered delays when no alignment is available.
 */

/**
 * Calculates timing data for a scene.
 * @param {object} scene - Parsed scene object
 * @param {number} audioDurationMs - Actual audio duration in ms
 * @param {Array} [alignment] - Word-level timestamps from TTS: [{ word, start_ms, end_ms }]
 * @returns {object} Timing data with OST timings
 */
export function calculateTimings(scene, audioDurationMs = 0, alignment = null) {
  const totalDurationMs = audioDurationMs || (scene.approxDurationSeconds * 1000);
  const content = scene.content;
  const isSlideshow = scene.sceneType === 'ai_image_slideshow';

  // Choose animation types
  const defaultAnim = isSlideshow ? 'anim-fadeIn' : 'anim-fadeSlideUp';
  const bulletAnim = isSlideshow ? 'anim-fadeIn' : 'anim-fadeSlideRight';

  // Collect all OST elements in display order
  const elements = [];

  if (content.headers) {
    content.headers.forEach((h, i) => {
      elements.push({ id: `header_${i + 1}`, text: h.text, animation: defaultAnim, type: 'header' });
    });
  }
  if (content.subHeaders) {
    content.subHeaders.forEach((s, i) => {
      elements.push({ id: `subheader_${i + 1}`, text: s.text, animation: defaultAnim, type: 'subheader' });
    });
  }
  if (content.keyPhrases) {
    content.keyPhrases.forEach((k, i) => {
      elements.push({ id: `keyphrase_${i + 1}`, text: k.text, animation: defaultAnim, type: 'keyphrase' });
    });
  }
  if (content.bulletPoints) {
    content.bulletPoints.forEach((b, i) => {
      elements.push({ id: `bullet_${i + 1}`, text: b.text, animation: bulletAnim, type: 'bullet' });
    });
  }

  let timings;

  if (alignment && alignment.length > 0 && elements.length > 0) {
    timings = syncTimingsToVoiceover(elements, alignment, totalDurationMs);
  } else {
    timings = fallbackStaggerTimings(elements, totalDurationMs);
  }

  return {
    scene_id: scene.sceneId,
    total_duration_ms: totalDurationMs,
    ost_timings: timings,
  };
}

// ─── Voiceover-synced timings ─────────────────────────────────────────────────

/**
 * Match each OST element to the voiceover and return timings synced to speech.
 *
 * Strategy:
 * 1. For each OST element, extract significant words (skip stop words)
 * 2. Search the alignment for the best matching window of consecutive words
 * 3. Set appear_ms to 200ms before the narrator says the first matched word
 * 4. Ensure minimum 300ms gap between elements and chronological order
 */
function syncTimingsToVoiceover(elements, alignment, totalDurationMs) {
  // Normalize alignment words for matching
  const alignWords = alignment.map(w => ({
    ...w,
    normalized: normalize(w.word),
  }));

  const rawTimings = elements.map(el => {
    const matchMs = findBestMatch(el.text, alignWords);
    return {
      element: el.id,
      animation: el.animation,
      matched_ms: matchMs,
    };
  });

  // Ensure chronological order: if an element matched earlier than
  // the previous one, push it forward
  const MIN_GAP = 300;
  const LEAD_TIME = 200; // show text 200ms before it's spoken
  let lastMs = 0;

  const timings = rawTimings.map((t, i) => {
    let appearMs;

    if (t.matched_ms !== null) {
      appearMs = Math.max(t.matched_ms - LEAD_TIME, 0);
    } else {
      // No match found — distribute evenly in remaining time
      const fraction = (i + 1) / (elements.length + 1);
      appearMs = Math.round(totalDurationMs * fraction);
    }

    // Enforce minimum gap from previous element
    if (i > 0 && appearMs < lastMs + MIN_GAP) {
      appearMs = lastMs + MIN_GAP;
    }

    // If this element would appear in the last 2 seconds, pull it back
    if (appearMs > totalDurationMs - 2000) {
      appearMs = totalDurationMs - 2000;
    }

    // Enforce minimum gap still applies after pullback
    if (i > 0 && appearMs < lastMs + MIN_GAP) {
      appearMs = lastMs + MIN_GAP;
    }

    lastMs = appearMs;
    return {
      element: t.element,
      appear_ms: appearMs,
      animation: t.animation,
    };
  });

  return timings;
}

/**
 * Find where an OST element's text best matches in the voiceover alignment.
 * Returns the start_ms of the first matched word, or null if no match.
 *
 * Uses a sliding window approach: extract significant words from the OST text,
 * then find the window in the alignment that contains the most matches.
 */
function findBestMatch(ostText, alignWords) {
  const ostWords = extractSignificantWords(ostText);
  if (ostWords.length === 0) return null;

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < alignWords.length; i++) {
    const aw = alignWords[i].normalized;

    // Check if this alignment word matches any OST word
    const isMatch = ostWords.some(ow => wordsMatch(aw, ow));
    if (!isMatch) continue;

    // Count how many OST words appear near this position
    const windowStart = Math.max(0, i - 2);
    const windowEnd = Math.min(alignWords.length, i + ostWords.length * 3);
    const nearby = alignWords.slice(windowStart, windowEnd).map(w => w.normalized);

    let score = 0;
    for (const ow of ostWords) {
      if (nearby.some(wn => wordsMatch(wn, ow))) {
        score++;
      }
    }

    // Require at least 40% of significant words to match nearby
    if (score > bestScore && score >= Math.ceil(ostWords.length * 0.4)) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return bestIdx >= 0 ? alignWords[bestIdx].start_ms : null;
}

/**
 * Extract significant words from text (skip stop words and short words).
 */
function extractSignificantWords(text) {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'this', 'that', 'these',
    'those', 'it', 'its', 'not', 'no', 'so', 'if', 'then', 'than',
    'from', 'as', 'into', 'about', 'up', 'out', 'your', 'you', 'we',
    'our', 'their', 'they', 'what', 'which', 'who', 'how', 'when',
  ]);

  return text
    .split(/\s+/)
    .map(normalize)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

/**
 * Check if two words match. Supports exact match and basic stem matching
 * (e.g. "repair" matches "repairs", "update" matches "updates").
 * Both words must be at least 3 chars to avoid false positives like "a"/"an".
 */
function wordsMatch(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  // Stem match: one word starts with the other (handles plurals, tenses)
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return longer.startsWith(shorter) && (longer.length - shorter.length) <= 3;
}

/**
 * Normalize a word for comparison: lowercase, strip punctuation.
 */
function normalize(word) {
  return word.toLowerCase().replace(/[^a-z0-9]/gi, '');
}

// ─── Fallback stagger timings ─────────────────────────────────────────────────

/**
 * Simple staggered delays when no alignment data is available.
 */
function fallbackStaggerTimings(elements, totalDurationMs) {
  const totalElements = elements.length;
  const fewElements = totalElements <= 3;

  let currentDelay = fewElements ? 300 : 500;
  const gapMap = {
    header:    fewElements ? 600 : 400,
    subheader: fewElements ? 500 : 350,
    keyphrase: fewElements ? 600 : 400,
    bullet:    0, // calculated below
  };

  const timings = [];
  const bullets = elements.filter(e => e.type === 'bullet');
  const nonBullets = elements.filter(e => e.type !== 'bullet');

  // Non-bullet elements first
  for (const el of nonBullets) {
    timings.push({
      element: el.id,
      appear_ms: currentDelay,
      animation: el.animation,
    });
    currentDelay += gapMap[el.type];
  }

  // Bullets spread across remaining duration
  if (bullets.length > 0) {
    const remainingTime = Math.max(1500, totalDurationMs - currentDelay - 1500);
    const bulletStep = Math.min(Math.floor(remainingTime / bullets.length), 1500);

    for (const el of bullets) {
      timings.push({
        element: el.id,
        appear_ms: currentDelay,
        animation: el.animation,
      });
      currentDelay += bulletStep;
    }
  }

  return timings;
}

/**
 * Calculates per-slide timings for slideshow scenes.
 */
export function calculateSlideshowTimings(scene, totalDurationMs) {
  const voScripts = scene.voScripts;
  if (voScripts.length <= 1) {
    return [{ start_ms: 0, end_ms: totalDurationMs, slide_index: 0 }];
  }

  const totalWords = voScripts.reduce((sum, v) => sum + wordCount(v.text), 0);
  let currentMs = 0;

  return voScripts.map((v, i) => {
    const words = wordCount(v.text);
    const proportion = totalWords > 0 ? words / totalWords : 1 / voScripts.length;
    const durationMs = Math.round(totalDurationMs * proportion);
    const slide = {
      start_ms: currentMs,
      end_ms: Math.min(currentMs + durationMs, totalDurationMs),
      slide_index: i,
    };
    currentMs += durationMs;
    return slide;
  });
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(w => w).length;
}
