import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const THEMES_CONFIG_PATH = join(__dirname, '../../config/themes.json');
const BASE_THEMES_DIR = join(__dirname, '../themes/base-themes');
const DOMAIN_OVERRIDES_DIR = join(__dirname, '../themes/domain-overrides');

let themesConfig = null;

async function loadConfig() {
  if (!themesConfig) {
    themesConfig = JSON.parse(await readFile(THEMES_CONFIG_PATH, 'utf-8'));
  }
  return themesConfig;
}

/**
 * Resolves the base theme name for a given domain key.
 * Uses the domain→theme mapping from config, or falls back to the provided override.
 */
export async function resolveThemeName(domainKey, themeOverride) {
  if (themeOverride) return themeOverride;
  const config = await loadConfig();
  return config.domain_theme_mapping[domainKey] || 'professional-blue';
}

/**
 * Loads a base theme CSS file and returns its content.
 */
export async function loadBaseThemeCSS(themeName) {
  const filePath = join(BASE_THEMES_DIR, `${themeName}.css`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Base theme not found: ${themeName}. Available: professional-blue, warm-earth, fresh-green, vibrant-orange, calm-neutral, bold-contrast`);
  }
}

/**
 * Loads a domain override CSS file. Returns empty string if no override exists.
 */
export async function loadDomainOverrideCSS(domainKey) {
  const fileName = domainKey.replace(/_/g, '-');
  const filePath = join(DOMAIN_OVERRIDES_DIR, `${fileName}.css`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Returns the combined theme CSS (base theme + domain override) as inline styles.
 * Strips the :root { } wrapper so it can be injected directly into a <style> block.
 */
export async function getThemeCSS(domainKey, themeOverride) {
  const themeName = await resolveThemeName(domainKey, themeOverride);
  const baseCSS = await loadBaseThemeCSS(themeName);
  const domainCSS = await loadDomainOverrideCSS(domainKey);

  return domainCSS ? `${baseCSS}\n\n/* Domain override: ${domainKey} */\n${domainCSS}` : baseCSS;
}

/**
 * Extracts CSS custom properties from a theme CSS string into a key-value object.
 * Useful for programmatic access to theme values.
 */
export function parseThemeVariables(css) {
  const vars = {};
  const regex = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let match;
  while ((match = regex.exec(css)) !== null) {
    vars[`--${match[1]}`] = match[2].trim();
  }
  return vars;
}

/**
 * Returns available base theme names.
 */
export async function getAvailableThemes() {
  const config = await loadConfig();
  return config.base_themes;
}
