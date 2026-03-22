import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStoryboard, getFullVoText, sceneNeedsAvatar, getAvatarCropStyle } from '../storyboard-parser.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLE_PATH = join(__dirname, '../../../sample/M2_L3_ML3.json');

describe('storyboard-parser', () => {
  it('parses sample storyboard without errors', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    assert.equal(sb.domainKey, 'motor_vehicle_workshop');
    assert.equal(sb.language, 'en');
    assert.equal(sb.numberOfScenes, 9);
    assert.equal(sb.scenes.length, 9);
  });

  it('extracts scene metadata correctly', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    const scene1 = sb.scenes[0];
    assert.equal(scene1.sceneId, 'M2_L3_ML3_SC1');
    assert.equal(scene1.character, 'Anil');
    assert.equal(scene1.sceneType, 'intro_scene');
  });

  it('parses vo_scripts with dynamic keys', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);

    // Single VO script (SC1)
    const scene1 = sb.scenes[0];
    assert.equal(scene1.voScripts.length, 1);
    assert.ok(scene1.voScripts[0].text.includes('Identify Gaps'));

    // Multiple VO scripts (slideshow scene SC4)
    const scene4 = sb.scenes[3];
    assert.equal(scene4.voScripts.length, 3);
    assert.equal(scene4.voScripts[0].index, 1);
    assert.equal(scene4.voScripts[2].index, 3);
  });

  it('parses content elements with dynamic keys', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    const scene2 = sb.scenes[1]; // learning_objective_scene

    assert.equal(scene2.content.headers.length, 1);
    assert.equal(scene2.content.headers[0].text, 'Learning Objectives');
    assert.equal(scene2.content.bulletPoints.length, 2);
    assert.equal(scene2.content.bulletPoints[0].index, 1);
  });

  it('parses media with image URLs and filters prompts', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    const scene1 = sb.scenes[0];

    assert.ok(scene1.content.media);
    assert.equal(scene1.content.media.compositeImage, false);
    assert.equal(scene1.content.media.imageAspectRatio, 'vertical');
    assert.equal(scene1.content.media.images.length, 1);
    assert.ok(scene1.content.media.images[0].url.startsWith('https://'));
  });

  it('handles composite images', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    const scene7 = sb.scenes[6]; // split_screen_image (SC7)

    assert.equal(scene7.content.media.compositeImage, true);
    assert.equal(scene7.content.media.numberOfSubImages, 4);
  });

  it('handles scenes with no images', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    const scene2 = sb.scenes[1]; // learning_objective_scene

    assert.equal(scene2.content.media.imageAspectRatio, '0');
    assert.equal(scene2.content.media.images.length, 0);
  });

  it('getFullVoText concatenates all VO scripts', async () => {
    const sb = await parseStoryboard(SAMPLE_PATH);
    const text = getFullVoText(sb.scenes[3]); // slideshow with 3 VOs (SC4)
    assert.ok(text.includes('observe customers'));
    assert.ok(text.includes('repeated complaints'));
  });

  it('sceneNeedsAvatar returns correct values', () => {
    assert.equal(sceneNeedsAvatar('learning_objective_scene'), true);
    assert.equal(sceneNeedsAvatar('avatar_image_circle'), true);
    assert.equal(sceneNeedsAvatar('intro_scene'), false);
    assert.equal(sceneNeedsAvatar('avatar_presenter_torso'), true);
    assert.equal(sceneNeedsAvatar('character_image_torso'), false);
    assert.equal(sceneNeedsAvatar('character_based_roleplay'), false);
    assert.equal(sceneNeedsAvatar('first_person_video_staticBg'), false);
    assert.equal(sceneNeedsAvatar('ai_image_slideshow'), false);
    assert.equal(sceneNeedsAvatar('table_image'), false);
  });

  it('getAvatarCropStyle returns correct crop styles', () => {
    assert.equal(getAvatarCropStyle('avatar_image_circle'), 'circle');
    assert.equal(getAvatarCropStyle('learning_objective_scene'), 'torso');
    assert.equal(getAvatarCropStyle('intro_scene'), null);
    assert.equal(getAvatarCropStyle('first_person_video_staticBg'), null);
    assert.equal(getAvatarCropStyle('ai_image_slideshow'), null);
  });
});
