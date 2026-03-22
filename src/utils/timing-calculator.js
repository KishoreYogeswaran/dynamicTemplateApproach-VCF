/**
 * Calculates animation timings for a scene.
 * Uses simple staggered delays — elements appear one after another
 * with a consistent rhythm.
 */

/**
 * Calculates timing data for a scene.
 * @param {object} scene - Parsed scene object
 * @param {number} audioDurationMs - Actual audio duration in ms (0 if not yet generated)
 * @returns {object} Timing data with OST timings
 */
export function calculateTimings(scene, audioDurationMs = 0) {
  const totalDurationMs = audioDurationMs || (scene.approxDurationSeconds * 1000);

  const timings = [];
  const content = scene.content;
  const isSlideshow = scene.sceneType === 'ai_image_slideshow';

  // Count total text elements to determine stagger
  const headerCount = (content.headers || []).length;
  const subHeaderCount = (content.subHeaders || []).length;
  const keyPhraseCount = (content.keyPhrases || []).length;
  const bulletCount = (content.bulletPoints || []).length;
  const totalElements = headerCount + subHeaderCount + keyPhraseCount + bulletCount;

  // For scenes with few elements (e.g. slideshow slides), space them out more
  const fewElements = totalElements <= 3;
  let currentDelay = fewElements ? 300 : 500;
  const headerGap = fewElements ? 600 : 400;
  const subHeaderGap = fewElements ? 500 : 350;
  const keyPhraseGap = fewElements ? 600 : 400;

  // Slideshow slides use pure fade (no transform) to avoid stutter over full-screen images
  const defaultAnim = isSlideshow ? 'anim-fadeIn' : 'anim-fadeSlideUp';
  const bulletAnim = isSlideshow ? 'anim-fadeIn' : 'anim-fadeSlideRight';

  // Headers
  if (content.headers) {
    content.headers.forEach((_h, i) => {
      timings.push({
        element: `header_${i + 1}`,
        appear_ms: currentDelay,
        animation: defaultAnim,
      });
      currentDelay += headerGap;
    });
  }

  // Sub-headers
  if (content.subHeaders) {
    content.subHeaders.forEach((_s, i) => {
      timings.push({
        element: `subheader_${i + 1}`,
        appear_ms: currentDelay,
        animation: defaultAnim,
      });
      currentDelay += subHeaderGap;
    });
  }

  // Key phrases
  if (content.keyPhrases) {
    content.keyPhrases.forEach((_k, i) => {
      timings.push({
        element: `keyphrase_${i + 1}`,
        appear_ms: currentDelay,
        animation: defaultAnim,
      });
      currentDelay += keyPhraseGap;
    });
  }

  // Bullet points — spread across remaining duration
  const bullets = content.bulletPoints || [];
  if (bullets.length > 0) {
    const remainingTime = Math.max(1500, totalDurationMs - currentDelay - 1500);
    const bulletStep = Math.min(Math.floor(remainingTime / bullets.length), 1500);

    bullets.forEach((_b, i) => {
      timings.push({
        element: `bullet_${i + 1}`,
        appear_ms: currentDelay,
        animation: bulletAnim,
      });
      currentDelay += bulletStep;
    });
  }

  return {
    scene_id: scene.sceneId,
    total_duration_ms: totalDurationMs,
    ost_timings: timings,
  };
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
