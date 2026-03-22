import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FONTS_CONFIG_PATH = join(__dirname, '../../config/fonts.json');

let fontsConfig = null;

async function loadConfig() {
  if (!fontsConfig) {
    fontsConfig = JSON.parse(await readFile(FONTS_CONFIG_PATH, 'utf-8'));
  }
  return fontsConfig;
}

/**
 * Returns font configuration for a given language code.
 * Falls back to English if the language is not supported.
 */
export async function getFontConfig(language) {
  const config = await loadConfig();
  return config[language] || config['en'];
}

/**
 * Generates the Google Fonts <link> tag for a given language.
 */
export async function generateFontLinkTag(language) {
  const font = await getFontConfig(language);
  const families = [];

  const primaryEncoded = encodeURIComponent(font.primary);
  families.push(`family=${primaryEncoded}:wght@${font.weight_range}`);

  if (font.heading !== font.primary) {
    const headingEncoded = encodeURIComponent(font.heading);
    families.push(`family=${headingEncoded}:wght@${font.weight_range}`);
  }

  const url = `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap`;
  return `<link href="${url}" rel="stylesheet">`;
}

/**
 * Generates CSS custom property declarations for fonts.
 */
export async function generateFontCSSVars(language) {
  const font = await getFontConfig(language);
  return `  --font-primary: '${font.primary}', sans-serif;\n  --font-heading: '${font.heading}', sans-serif;`;
}

/**
 * Returns all supported language codes.
 */
export async function getSupportedLanguages() {
  const config = await loadConfig();
  return Object.keys(config);
}
