import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getFontConfig, generateFontLinkTag, generateFontCSSVars, getSupportedLanguages } from '../font-loader.js';

describe('font-loader', () => {
  it('returns English font config', async () => {
    const config = await getFontConfig('en');
    assert.equal(config.primary, 'Noto Sans');
    assert.equal(config.heading, 'Noto Sans Display');
  });

  it('returns Hindi font config', async () => {
    const config = await getFontConfig('hi');
    assert.equal(config.primary, 'Noto Sans Devanagari');
  });

  it('falls back to English for unknown language', async () => {
    const config = await getFontConfig('zz');
    assert.equal(config.primary, 'Noto Sans');
  });

  it('generates Google Fonts link tag with both families', async () => {
    const tag = await generateFontLinkTag('en');
    assert.ok(tag.includes('fonts.googleapis.com'));
    assert.ok(tag.includes('Noto%20Sans'));
    assert.ok(tag.includes('Noto%20Sans%20Display'));
    assert.ok(tag.includes('400;500;600;700'));
  });

  it('generates single family link when primary === heading', async () => {
    const tag = await generateFontLinkTag('hi');
    // Hindi uses Noto Sans Devanagari for both
    const matches = tag.match(/family=/g);
    assert.equal(matches.length, 1);
  });

  it('generates font CSS variables', async () => {
    const css = await generateFontCSSVars('en');
    assert.ok(css.includes("--font-primary: 'Noto Sans'"));
    assert.ok(css.includes("--font-heading: 'Noto Sans Display'"));
  });

  it('lists all supported languages', async () => {
    const langs = await getSupportedLanguages();
    assert.ok(langs.includes('en'));
    assert.ok(langs.includes('hi'));
    assert.ok(langs.includes('ta'));
    assert.ok(langs.length >= 9);
  });
});
