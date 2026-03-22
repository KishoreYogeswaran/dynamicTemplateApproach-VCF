import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveThemeName, loadBaseThemeCSS, loadDomainOverrideCSS, getThemeCSS, parseThemeVariables, getAvailableThemes } from '../theme-loader.js';

describe('theme-loader', () => {
  it('resolves theme from domain mapping', async () => {
    const theme = await resolveThemeName('motor_vehicle_workshop');
    assert.equal(theme, 'vibrant-orange');
  });

  it('uses override when provided', async () => {
    const theme = await resolveThemeName('motor_vehicle_workshop', 'professional-blue');
    assert.equal(theme, 'professional-blue');
  });

  it('falls back to professional-blue for unknown domains', async () => {
    const theme = await resolveThemeName('unknown_domain');
    assert.equal(theme, 'professional-blue');
  });

  it('loads all 6 base themes without error', async () => {
    const themes = ['professional-blue', 'warm-earth', 'fresh-green', 'vibrant-orange', 'calm-neutral', 'bold-contrast'];
    for (const t of themes) {
      const css = await loadBaseThemeCSS(t);
      assert.ok(css.includes('--theme-primary'));
      assert.ok(css.includes('--theme-bg-gradient'));
    }
  });

  it('throws for invalid theme name', async () => {
    await assert.rejects(() => loadBaseThemeCSS('nonexistent'), /Base theme not found/);
  });

  it('loads domain overrides', async () => {
    const css = await loadDomainOverrideCSS('motor_vehicle_workshop');
    assert.ok(css.includes('--domain-accent'));
  });

  it('returns empty string for missing domain override', async () => {
    const css = await loadDomainOverrideCSS('unknown_domain');
    assert.equal(css, '');
  });

  it('combines theme + domain override', async () => {
    const css = await getThemeCSS('motor_vehicle_workshop');
    assert.ok(css.includes('--theme-primary'));
    assert.ok(css.includes('--domain-accent'));
    assert.ok(css.includes('Domain override'));
  });

  it('parses CSS variables correctly', async () => {
    const css = await loadBaseThemeCSS('professional-blue');
    const vars = parseThemeVariables(css);
    assert.equal(vars['--theme-primary'], '#2563EB');
    assert.ok(vars['--theme-bg-gradient'].includes('linear-gradient'));
  });

  it('lists available themes', async () => {
    const themes = await getAvailableThemes();
    assert.equal(themes.length, 6);
    assert.ok(themes.includes('professional-blue'));
  });
});
