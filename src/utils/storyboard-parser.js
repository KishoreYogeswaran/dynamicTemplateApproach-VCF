import { readFile } from 'fs/promises';

/**
 * Parses a storyboard JSON file and extracts structured scene data.
 * Handles dynamic key patterns for vo_scripts, content_elements, and media.
 */
export async function parseStoryboard(filePath) {
  const raw = JSON.parse(await readFile(filePath, 'utf-8'));
  return normalizeStoryboard(raw);
}

export function normalizeStoryboard(raw) {
  const moduleNum = raw.module_number || 1;
  const lessonNum = raw.lesson_number || 1;
  const mlId = raw.ml_id || `ML${lessonNum}`;

  const storyboard = {
    domainKey: raw.domain_key,
    moduleNumber: moduleNum,
    moduleName: raw.module_name,
    lessonNumber: lessonNum,
    lessonName: raw.lesson_name,
    mlId,
    mlTitle: raw.ml_title,
    // Derived path segments for output structure: domain/M2/M2_L3/M2_L3_ML3/
    moduleKey: `M${moduleNum}`,
    lessonKey: `M${moduleNum}_L${lessonNum}`,
    mlKey: `M${moduleNum}_L${lessonNum}_${mlId}`,
    learningObjectives: raw.learning_objectives || [],
    language: raw.language || 'en',
    totalWordCount: raw.total_word_count,
    approxDurationSeconds: raw.approximate_duration_seconds,
    numberOfScenes: raw.number_of_scenes,
    scenes: (raw.scenes || []).map(parseScene),
  };

  return storyboard;
}

function parseScene(scene) {
  return {
    sceneId: scene.scene_id,
    character: scene.character,
    wordCount: scene.word_count,
    approxDurationSeconds: scene.approx_duration_seconds,
    voScripts: extractVoScripts(scene.vo_scripts),
    sceneType: scene.scene_typology_name,
    selectedTemplateName: scene.selected_template_name,
    selectedFamilyName: scene.selected_family_name,
    characterCrop: scene.characterCrop,
    characterPosition: scene.characterPosition,
    content: parseContentElements(scene.content_elements),
  };
}

/**
 * Extracts VO scripts from dynamic keys.
 * Keys follow pattern: *_voScript_N
 * Returns ordered array of { key, index, text }.
 */
function extractVoScripts(voScripts) {
  if (!voScripts) return [];

  const entries = Object.entries(voScripts)
    .filter(([key]) => /_voScript_\d+$/.test(key))
    .map(([key, text]) => {
      const match = key.match(/_voScript_(\d+)$/);
      return { key, index: parseInt(match[1], 10), text };
    })
    .sort((a, b) => a.index - b.index);

  return entries;
}

/**
 * Parses content_elements, extracting headers, subHeaders, bulletPoints,
 * keyPhrases, and media with their dynamic keys.
 */
function parseContentElements(content) {
  if (!content) return { headers: [], subHeaders: [], bulletPoints: [], keyPhrases: [], media: null };

  return {
    headers: extractIndexedEntries(content.headers, '_header_'),
    subHeaders: extractIndexedEntries(content.subHeaders, '_subHeader_'),
    bulletPoints: extractIndexedEntries(content.bulletPoints, '_bulletpoint_'),
    keyPhrases: extractIndexedEntries(content.keyPhrases, '_keyPhrase_'),
    media: parseMedia(content.media),
  };
}

/**
 * Generic extractor for indexed content elements.
 * Matches keys containing the pattern (e.g., _header_1, _bulletpoint_3).
 */
function extractIndexedEntries(obj, pattern) {
  if (!obj) return [];

  const regex = new RegExp(`${escapeRegex(pattern)}(\\d+)$`);

  return Object.entries(obj)
    .filter(([key]) => regex.test(key))
    .map(([key, text]) => {
      const match = key.match(regex);
      return { key, index: parseInt(match[1], 10), text };
    })
    .sort((a, b) => a.index - b.index);
}

/**
 * Parses media object — extracts image, audio, and video URLs,
 * filters out prompt keys, and captures composite/aspect metadata.
 */
function parseMedia(media) {
  if (!media) return null;

  // Extract image prompts (describe image composition/layout)
  const imagePrompts = {};
  Object.entries(media)
    .filter(([key]) => /_image_\d+_prompt$/.test(key))
    .forEach(([key, text]) => {
      const match = key.match(/_image_(\d+)_prompt$/);
      imagePrompts[parseInt(match[1], 10)] = text;
    });

  const images = Object.entries(media)
    .filter(([key]) => /_image_\d+$/.test(key))
    .map(([key, url]) => {
      const match = key.match(/_image_(\d+)$/);
      const index = parseInt(match[1], 10);
      return { key, index, url, prompt: imagePrompts[index] || '' };
    })
    .sort((a, b) => a.index - b.index);

  const audios = Object.entries(media)
    .filter(([key]) => /_audio_\d+$/.test(key))
    .map(([key, url]) => {
      const match = key.match(/_audio_(\d+)$/);
      return { key, index: parseInt(match[1], 10), url };
    })
    .sort((a, b) => a.index - b.index);

  const videos = Object.entries(media)
    .filter(([key]) => /_video_\d+$/.test(key))
    .map(([key, url]) => {
      const match = key.match(/_video_(\d+)$/);
      return { key, index: parseInt(match[1], 10), url };
    })
    .sort((a, b) => a.index - b.index);

  return {
    compositeImage: media.compositeImage === 'TRUE',
    imageAspectRatio: media.image_aspectRatio || '0',
    numberOfSubImages: media.numberOf_subImages || 0,
    subimageAspectRatio: media.subimage_aspectRatio || '',
    images,
    audios,
    videos,
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns the full concatenated VO text for a scene.
 */
export function getFullVoText(scene) {
  return scene.voScripts.map(v => v.text).join(' ');
}

/**
 * Returns true if the scene type requires an avatar/character video overlay.
 */
export function sceneNeedsAvatar(sceneType) {
  // Only narrator avatar scenes need WAN-generated avatar overlays.
  // character_image_torso, character_based_roleplay, and first_person_video_staticBg
  // receive pre-rendered full videos via media URLs — no separate avatar needed.
  const avatarScenes = new Set([
    'learning_objective_scene',
    'avatar_presenter_torso',
    'avatar_image_circle',
  ]);
  return avatarScenes.has(sceneType);
}

/**
 * Returns the avatar crop style for a given scene type.
 */
export function getAvatarCropStyle(sceneType) {
  const cropMap = {
    'learning_objective_scene': 'torso',
    'avatar_presenter_torso': 'torso',
    'avatar_image_circle': 'circle',
  };
  return cropMap[sceneType] || null;
}

/**
 * Returns true if the scene has a pre-rendered video URL in media.
 */
export function sceneHasMediaVideo(scene) {
  return (scene.content?.media?.videos?.length || 0) > 0;
}

/**
 * Returns true if the scene has a pre-rendered audio URL in media.
 */
export function sceneHasMediaAudio(scene) {
  return (scene.content?.media?.audios?.length || 0) > 0;
}
