/**
 * Resolves the narrator reference image path for a given domain.
 * Used by the WAN S2V pipeline to generate talking-head avatar videos.
 */

import { readFile, access } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = join(__dirname, '../../config/character_images.json');
const IMAGES_DIR = join(__dirname, '../../config/character_images');

let config = null;

async function loadConfig() {
  if (!config) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }
  return config;
}

/**
 * Get the narrator name for a domain.
 */
export async function getNarratorName(domainKey) {
  const cfg = await loadConfig();
  return cfg[domainKey]?.narrator || null;
}

/**
 * Get the absolute path to the narrator reference image for a domain.
 * Returns null if the domain isn't configured or the image file is missing.
 */
export async function getNarratorImagePath(domainKey) {
  const cfg = await loadConfig();
  const entry = cfg[domainKey];

  if (!entry?.image) return null;

  const imagePath = join(IMAGES_DIR, entry.image);

  try {
    await access(imagePath);
    return imagePath;
  } catch {
    return null;
  }
}

/**
 * Check whether a scene's character is the domain narrator.
 * Only narrators get TTS + WAN video generation.
 */
export async function isNarrator(characterName, domainKey) {
  const narrator = await getNarratorName(domainKey);
  if (!narrator || !characterName) return false;
  return characterName.toUpperCase().includes(narrator.toUpperCase());
}
