/**
 * Pipeline Orchestrator
 *
 * For each scene in a storyboard:
 *   1. Determine what's needed (TTS audio, avatar video)
 *   2. Generate TTS via ElevenLabs for narrator scenes without media audio
 *   3. Generate avatar video via WAN S2V + FIBO background removal
 *   4. Calculate animation timings from actual audio duration
 *   5. Pass everything to LLM HTML renderer (Gemini)
 *
 * Usage:
 *   import { runPipeline } from './orchestrator.js';
 *   await runPipeline(storyboardPath, { outputDir, concurrency });
 */

import { resolve, join } from 'path';
import { mkdir, writeFile, readFile, stat, unlink } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseStoryboard, getFullVoText, sceneNeedsAvatar, getAvatarCropStyle, sceneHasMediaAudio, sceneHasMediaVideo } from '../utils/storyboard-parser.js';
import { isNarrator, getNarratorImagePath } from '../utils/character-image-resolver.js';
import { calculateTimings } from '../utils/timing-calculator.js';
import { ElevenLabsTTSClient } from '../clients/elevenlabs-tts-client.js';
import { WanS2VClient } from '../clients/wan-s2v-client.js';
import { TransparentVideoClient } from '../clients/transparent-video-client.js';
import { AzureMediaUploader } from '../clients/azure-uploader.js';
import { renderSceneHTMLWithLLM } from './llm-html-renderer.js';
import { recordScene } from './puppeteer-recorder.js';
import { stitchScenes } from './video-stitcher.js';

const execFileAsync = promisify(execFile);

/**
 * Get audio duration in milliseconds using ffprobe.
 */
async function getAudioDurationMs(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    return Math.round(parseFloat(stdout.trim()) * 1000);
  } catch {
    return 0;
  }
}

/**
 * Create or reuse an Azure uploader instance for the pipeline run.
 * Initialized lazily on first use.
 */
let _uploader = null;
function getUploader(domainKey) {
  if (!_uploader) {
    _uploader = new AzureMediaUploader({ domainName: domainKey });
  }
  return _uploader;
}

// ─── Slideshow expansion ─────────────────────────────────────────────────────

/**
 * Expand slideshow scenes into individual sub-scenes.
 * A slideshow scene with 3 slides becomes 3 separate scenes,
 * each with its own voScript, header, keyphrase, and image.
 */
function expandSlideshowScenes(scenes) {
  const expanded = [];

  for (const scene of scenes) {
    if (scene.sceneType !== 'ai_image_slideshow') {
      expanded.push(scene);
      continue;
    }

    const slideCount = scene.voScripts.length;
    if (slideCount <= 1) {
      expanded.push(scene);
      continue;
    }

    const images = scene.content.media?.images || [];
    const headers = scene.content.headers || [];
    const subHeaders = scene.content.subHeaders || [];
    const keyPhrases = scene.content.keyPhrases || [];

    for (let i = 0; i < slideCount; i++) {
      const slideScene = {
        sceneId: `${scene.sceneId}_slide${i + 1}`,
        character: scene.character,
        wordCount: Math.round((scene.wordCount || 0) / slideCount),
        approxDurationSeconds: Math.round((scene.approxDurationSeconds || 10) / slideCount),
        voScripts: [scene.voScripts[i]],
        sceneType: 'ai_image_slideshow',
        selectedTemplateName: scene.selectedTemplateName,
        selectedFamilyName: scene.selectedFamilyName,
        characterCrop: scene.characterCrop,
        characterPosition: scene.characterPosition,
        content: {
          headers: headers[i] ? [headers[i]] : [],
          subHeaders: subHeaders[i] ? [subHeaders[i]] : [],
          bulletPoints: [],
          keyPhrases: keyPhrases[i] ? [keyPhrases[i]] : [],
          media: {
            compositeImage: false,
            imageAspectRatio: scene.content.media?.imageAspectRatio || '0',
            numberOfSubImages: 0,
            images: images[i] ? [images[i]] : [],
            audios: [],
            videos: [],
          },
        },
      };

      expanded.push(slideScene);
    }

    console.log(`  [expand] ${scene.sceneId}: Expanded slideshow into ${slideCount} individual slides`);
  }

  return expanded;
}

// ─── Scene analysis ──────────────────────────────────────────────────────────

/**
 * Analyze what each scene needs before HTML generation.
 */
async function analyzeScene(scene, storyboard) {
  const needs = {
    tts: false,         // needs ElevenLabs TTS generation
    avatar: false,      // needs WAN S2V avatar generation
    avatarCrop: null,   // 'torso' | 'circle'
    hasMediaAudio: sceneHasMediaAudio(scene),
    hasMediaVideo: sceneHasMediaVideo(scene),
  };

  // Check if scene needs TTS: narrator scene without pre-existing audio
  const narratorScene = await isNarrator(scene.character, storyboard.domainKey);
  if (narratorScene && !needs.hasMediaAudio && scene.voScripts.length > 0) {
    needs.tts = true;
  }

  // Check if scene needs avatar overlay
  if (sceneNeedsAvatar(scene.sceneType)) {
    needs.avatar = true;
    needs.avatarCrop = getAvatarCropStyle(scene.sceneType);
  }

  return needs;
}

// ─── Step 1: TTS Generation ─────────────────────────────────────────────────

async function generateTTS(scene, storyboard, outputDir) {
  const ttsClient = new ElevenLabsTTSClient();
  await ttsClient.loadCharacterVoices();

  const voText = getFullVoText(scene);
  if (!voText.trim()) {
    console.log(`  [tts] ${scene.sceneId}: No VO text, skipping TTS.`);
    return null;
  }

  const audioPath = join(outputDir, `${scene.sceneId}_vo.mp3`);
  console.log(`  [tts] ${scene.sceneId}: Generating speech with timestamps (${voText.length} chars)...`);

  const result = await ttsClient.generateSpeechWithTimestamps({
    text: voText,
    outputPath: audioPath,
    characterName: scene.character,
    language: storyboard.language,
  });

  if (!result.success) {
    console.error(`  [tts] ${scene.sceneId}: FAILED — ${result.error}`);
    return { audioPath: null, alignment: null };
  }

  console.log(`  [tts] ${scene.sceneId}: ✓ Audio saved (${result.alignment?.length || 0} words aligned)`);
  return { audioPath, alignment: result.alignment || null };
}

// ─── Step 2: Avatar Video Generation ────────────────────────────────────────

async function generateAvatar(scene, storyboard, audioPath, outputDir) {
  const narratorImagePath = await getNarratorImagePath(storyboard.domainKey);
  if (!narratorImagePath) {
    console.error(`  [avatar] ${scene.sceneId}: No narrator image found for domain "${storyboard.domainKey}".`);
    return { videoPath: null, extractedAudioPath: null };
  }

  // Upload audio + image to Azure for public URLs (WAN needs HTTPS URLs)
  const uploader = getUploader(storyboard.domainKey);
  const audioUrl = await uploader.uploadFile({
    localPath: audioPath,
    sceneId: scene.sceneId,
    contentType: 'audio/mpeg',
  });
  const imageUrl = await uploader.uploadFile({
    localPath: narratorImagePath,
    sceneId: scene.sceneId,
    contentType: 'image/png',
  });

  const wanOutputDir = join(outputDir, scene.sceneId);
  await mkdir(wanOutputDir, { recursive: true });
  const wanVideoPath = join(wanOutputDir, 'avatar_raw.mp4');

  // Step 2a: Generate talking-head video via WAN S2V
  console.log(`  [avatar] ${scene.sceneId}: Generating WAN S2V video...`);
  const wanClient = new WanS2VClient();
  const wanResult = await wanClient.generateAndDownload({
    audioUrl,
    imageUrl,
    prompt: 'A person speaking naturally with subtle head movements and expressions',
    outputPath: wanVideoPath,
  });

  if (!wanResult.success) {
    console.error(`  [avatar] ${scene.sceneId}: WAN FAILED — ${wanResult.error}`);
    return { videoPath: null, extractedAudioPath: null };
  }

  console.log(`  [avatar] ${scene.sceneId}: ✓ WAN video generated (${wanResult.processingTime?.toFixed(1)}s)`);

  // Step 2b: Extract audio from WAN video — this is the audio the lips were synced to
  const extractedAudioPath = join(wanOutputDir, 'avatar_audio.mp3');
  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', wanVideoPath,
      '-vn', '-c:a', 'libmp3lame', '-b:a', '192k',
      extractedAudioPath,
    ], { timeout: 30000 });
    console.log(`  [avatar] ${scene.sceneId}: ✓ Extracted audio from WAN video`);
  } catch (err) {
    console.error(`  [avatar] ${scene.sceneId}: Audio extraction failed — ${err.message}`);
  }

  // Step 2c: Remove background via FIBO
  console.log(`  [avatar] ${scene.sceneId}: Removing background via FIBO...`);
  const bgRemover = new TransparentVideoClient();

  // FIBO needs a public URL for the video
  const videoUrl = wanResult.videoUrl; // Already a public URL from WAN
  const bgResult = await bgRemover.removeBackground({
    inputVideo: wanVideoPath,
    outputDir: wanOutputDir,
    videoUrl,
  });

  if (!bgResult.success) {
    console.error(`  [avatar] ${scene.sceneId}: FIBO FAILED — ${bgResult.error}`);
    // Fall back to raw video without transparency
    return { videoPath: wanVideoPath, extractedAudioPath };
  }

  // Step 2c: Compress ProRes MOV → VP9 WebM with alpha (75MB → ~2-3MB)
  const compressedPath = join(wanOutputDir, 'avatar_transparent.webm');
  console.log(`  [avatar] ${scene.sceneId}: Compressing to WebM with alpha...`);

  try {
    await execFileAsync('ffmpeg', [
      '-i', bgResult.transparentVideo,
      '-c:v', 'libvpx-vp9',
      '-pix_fmt', 'yuva420p',
      '-b:v', '1M',
      '-auto-alt-ref', '0',
      '-an',
      '-y', compressedPath,
    ], { timeout: 300_000 });

    const originalSize = (await stat(bgResult.transparentVideo)).size;
    const compressedSize = (await stat(compressedPath)).size;
    console.log(`  [avatar] ${scene.sceneId}: ✓ Compressed ${(originalSize / 1024 / 1024).toFixed(1)}MB → ${(compressedSize / 1024 / 1024).toFixed(1)}MB`);

    return { videoPath: compressedPath, extractedAudioPath };
  } catch (err) {
    console.error(`  [avatar] ${scene.sceneId}: Compression failed — ${err.message}, using uncompressed`);
    return { videoPath: bgResult.transparentVideo, extractedAudioPath };
  }
}

// ─── Step 3: Audio from media URL ───────────────────────────────────────────

async function downloadMediaAudio(scene, outputDir) {
  const audios = scene.content?.media?.audios || [];
  if (audios.length === 0) return null;

  const audioUrl = audios[0].url;
  const audioPath = join(outputDir, `${scene.sceneId}_media_audio.mp3`);

  try {
    console.log(`  [audio] ${scene.sceneId}: Downloading media audio...`);
    const response = await fetch(audioUrl, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(audioPath, buffer);

    console.log(`  [audio] ${scene.sceneId}: ✓ Media audio downloaded`);
    return audioPath;
  } catch (err) {
    console.error(`  [audio] ${scene.sceneId}: Download failed — ${err.message}`);
    return null;
  }
}

// ─── Step 3b: Generate alignment for scenes with media audio ─────────────────

/**
 * For scenes that have media audio (not TTS), we still need word-level
 * alignment for OST sync. Generate TTS just for timestamps, discard the audio.
 */
async function getAlignmentForMediaAudio(scene, storyboard, outputDir) {
  const voText = getFullVoText(scene);
  if (!voText.trim()) return null;

  const ttsClient = new ElevenLabsTTSClient();
  await ttsClient.loadCharacterVoices();

  const tempPath = join(outputDir, `${scene.sceneId}_alignment_temp.mp3`);

  console.log(`  [align] ${scene.sceneId}: Generating alignment from voScript...`);
  const result = await ttsClient.generateSpeechWithTimestamps({
    text: voText,
    outputPath: tempPath,
    characterName: scene.character,
    language: storyboard.language,
  });

  // Discard the temp audio — we only needed timestamps
  unlink(tempPath).catch(() => {});

  if (!result.success) {
    console.error(`  [align] ${scene.sceneId}: FAILED — ${result.error}`);
    return null;
  }

  console.log(`  [align] ${scene.sceneId}: ✓ Got ${result.alignment?.length || 0} word timestamps`);
  return result.alignment || null;
}

// ─── Concurrency pool ────────────────────────────────────────────────────────

/**
 * Run async tasks with a concurrency limit.
 * Each task is a function returning a promise.
 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const i = nextIndex++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ─── Per-scene pipeline ──────────────────────────────────────────────────────

/**
 * Process a single scene through its entire pipeline:
 * TTS → Avatar → Upload → HTML → Record
 * Each scene is self-contained — dependencies are resolved internally.
 */
async function processScene(scene, sceneIdx, allScenes, storyboard, ctx) {
  const { audioDir, avatarDir, htmlDir, videoDir, skipTTS, skipAvatar, skipRecord, fps, themeOverride } = ctx;
  const sceneId = scene.sceneId;
  const needs = await analyzeScene(scene, storyboard);

  const flags = [];
  if (needs.tts) flags.push('TTS');
  if (needs.avatar) flags.push(`Avatar(${needs.avatarCrop})`);
  if (needs.hasMediaAudio) flags.push('MediaAudio');
  if (needs.hasMediaVideo) flags.push('MediaVideo');
  console.log(`\n[${sceneId}] Starting — ${scene.sceneType} | ${flags.length ? flags.join(', ') : 'HTML only'}`);

  const result = {
    sceneId,
    sceneType: scene.sceneType,
    audioPath: '',
    audioUrl: '',
    avatarVideoUrl: '',
    audioDurationMs: 0,
    htmlPath: '',
    videoPath: '',
    recordSuccess: false,
  };

  // Step 1: Audio — TTS or download media audio
  let wordAlignment = null;

  if (needs.tts && !skipTTS) {
    const ttsResult = await generateTTS(scene, storyboard, audioDir);
    result.audioPath = ttsResult.audioPath || '';
    wordAlignment = ttsResult.alignment;

    // Save alignment for reuse with --skip-tts
    if (wordAlignment) {
      const alignPath = join(audioDir, `${sceneId}_alignment.json`);
      await writeFile(alignPath, JSON.stringify(wordAlignment, null, 2));
    }
  } else if (needs.tts && skipTTS) {
    // Reuse existing audio file if available
    const existingAudio = join(audioDir, `${sceneId}_vo.mp3`);
    try { await stat(existingAudio); result.audioPath = existingAudio; console.log(`  [tts] ${sceneId}: Reusing existing audio`); } catch { /* no existing file */ }

    // Load saved alignment, or generate alignment-only if missing
    const alignPath = join(audioDir, `${sceneId}_alignment.json`);
    try {
      const data = await readFile(alignPath, 'utf-8');
      wordAlignment = JSON.parse(data);
      console.log(`  [timing] ${sceneId}: Loaded saved alignment (${wordAlignment.length} words)`);
    } catch {
      // No saved alignment — generate one from voScript (discards temp audio)
      if (result.audioPath) {
        wordAlignment = await getAlignmentForMediaAudio(scene, storyboard, audioDir);
        if (wordAlignment) {
          await writeFile(alignPath, JSON.stringify(wordAlignment, null, 2));
        }
      }
    }
  }
  if (!result.audioPath && needs.hasMediaAudio) {
    result.audioPath = await downloadMediaAudio(scene, audioDir) || '';

    // Media audio scenes: generate alignment from voScript
    if (result.audioPath && !wordAlignment) {
      const alignPath = join(audioDir, `${sceneId}_alignment.json`);
      try {
        const data = await readFile(alignPath, 'utf-8');
        wordAlignment = JSON.parse(data);
        console.log(`  [timing] ${sceneId}: Loaded saved alignment (${wordAlignment.length} words)`);
      } catch {
        wordAlignment = await getAlignmentForMediaAudio(scene, storyboard, audioDir);
        if (wordAlignment) {
          await writeFile(alignPath, JSON.stringify(wordAlignment, null, 2));
        }
      }
    }
  }

  // Step 2: Avatar — needs audio first
  let avatarLocalPath = '';
  if (needs.avatar && !skipAvatar && result.audioPath) {
    const avatarResult = await generateAvatar(scene, storyboard, result.audioPath, avatarDir);
    avatarLocalPath = avatarResult.videoPath || '';

    // Use audio extracted from WAN video — this is what the lips were synced to
    if (avatarResult.extractedAudioPath) {
      try {
        await stat(avatarResult.extractedAudioPath);
        result.audioPath = avatarResult.extractedAudioPath;
        console.log(`  [avatar] ${sceneId}: Using WAN-extracted audio for perfect lip sync`);
      } catch { /* extraction failed, keep original TTS audio */ }
    }
  } else if (needs.avatar && skipAvatar) {
    // Reuse existing avatar file if available
    const existingWebm = join(avatarDir, sceneId, 'avatar_transparent.webm');
    const existingMp4 = join(avatarDir, sceneId, 'avatar_raw.mp4');
    try { await stat(existingWebm); avatarLocalPath = existingWebm; console.log(`  [avatar] ${sceneId}: Reusing existing WebM`); } catch {
      try { await stat(existingMp4); avatarLocalPath = existingMp4; console.log(`  [avatar] ${sceneId}: Reusing existing MP4`); } catch { /* no existing file */ }
    }

    // Also reuse extracted audio if available
    const existingExtractedAudio = join(avatarDir, sceneId, 'avatar_audio.mp3');
    try {
      await stat(existingExtractedAudio);
      result.audioPath = existingExtractedAudio;
      console.log(`  [avatar] ${sceneId}: Reusing WAN-extracted audio`);
    } catch { /* no extracted audio, keep TTS */ }
  }

  // Step 3: Upload assets to Azure
  const uploader = getUploader(storyboard.domainKey);

  if (result.audioPath) {
    result.audioUrl = await uploader.uploadFile({
      localPath: result.audioPath,
      sceneId,
      contentType: 'audio/mpeg',
    });
  }

  if (avatarLocalPath) {
    const ct = avatarLocalPath.endsWith('.webm') ? 'video/webm' : 'video/mp4';
    result.avatarVideoUrl = await uploader.uploadFile({
      localPath: avatarLocalPath,
      sceneId,
      contentType: ct,
    });
  }

  // Step 4: Calculate timings + render HTML via LLM
  // Duration comes from the audio file (WAN-extracted for avatar scenes, TTS/media for others)
  const durationSource = result.audioPath;
  if (durationSource) {
    result.audioDurationMs = await getAudioDurationMs(durationSource);
  }
  const timings = calculateTimings(scene, result.audioDurationMs, wordAlignment);
  if (wordAlignment) {
    console.log(`  [timing] ${sceneId}: alignment=${wordAlignment.length} words, duration=${result.audioDurationMs}ms`);
  }
  if (timings.ost_timings.length > 0) {
    const ostSummary = timings.ost_timings.map(t => `${t.element}@${t.appear_ms}ms`).join(', ');
    console.log(`  [timing] ${sceneId}: OST timings: ${ostSummary}`);
  }

  const neighbors = {
    prev: sceneIdx > 0 ? allScenes[sceneIdx - 1] : null,
    next: sceneIdx < allScenes.length - 1 ? allScenes[sceneIdx + 1] : null,
  };

  result.htmlPath = await renderSceneHTMLWithLLM(scene, storyboard, {
    themeOverride,
    audioUrl: result.audioUrl,
    avatarVideoUrl: result.avatarVideoUrl,
    timings,
    outputDir: htmlDir,
    neighbors,
  });

  // Step 5: Record HTML → MP4 via Puppeteer
  if (!skipRecord && result.htmlPath) {
    const videoPath = join(videoDir, `${sceneId}.mp4`);
    console.log(`[${sceneId}] Recording...`);

    // Audio always comes from the TTS MP3 (avatar video is muted)
    const recordAudioPath = result.audioPath;

    const recResult = await recordScene({
      htmlPath: result.htmlPath,
      outputPath: videoPath,
      audioPath: recordAudioPath,
      durationMs: result.audioDurationMs,
      fps,
    });
    if (recResult.success) {
      result.videoPath = videoPath;
      result.recordSuccess = true;
      console.log(`[${sceneId}] ✓ Complete → ${videoPath}`);
    } else {
      console.error(`[${sceneId}] ✗ Recording failed: ${recResult.error}`);
    }
  } else {
    console.log(`[${sceneId}] ✓ HTML ready → ${result.htmlPath}`);
  }

  return result;
}

// ─── Main orchestrator ──────────────────────────────────────────────────────

/**
 * Run the full pipeline for a storyboard.
 * Each scene runs through its entire pipeline independently.
 * Scenes run in parallel up to the concurrency limit.
 *
 * @param {string} storyboardPath — path to storyboard JSON
 * @param {object} [opts]
 * @param {string}  [opts.outputDir]    — base output directory (default: output/pipeline)
 * @param {number}  [opts.concurrency]  — max parallel scenes (default: 3)
 * @param {string}  [opts.sceneFilter]  — only process scenes matching this ID substring
 * @param {boolean} [opts.skipTTS]      — skip TTS generation
 * @param {boolean} [opts.skipAvatar]   — skip avatar generation
 * @param {boolean} [opts.skipRecord]   — skip Puppeteer recording
 * @param {boolean} [opts.skipStitch]   — skip FFmpeg stitching
 * @param {boolean} [opts.stitchOnly]  — only stitch existing MP4s, skip all generation
 * @param {number}  [opts.fps]          — recording FPS (default: 24)
 * @param {number}  [opts.crossfadeMs]  — crossfade between scenes in ms (default: 0 = hard cut)
 * @param {string}  [opts.themeOverride] — override theme name
 */
export async function runPipeline(storyboardPath, opts = {}) {
  const {
    outputDir = resolve('output/pipeline'),
    concurrency = 3,
    sceneFilter = null,
    skipTTS = false,
    skipAvatar = false,
    skipRecord = false,
    skipStitch = false,
    stitchOnly = false,
    fps = 24,
    crossfadeMs = 0,
    gapMs = 700,
    themeOverride = null,
  } = opts;

  // Reset uploader for this run (domain-scoped)
  _uploader = null;

  // Directories
  const audioDir = join(outputDir, 'audio');
  const avatarDir = join(outputDir, 'avatars');
  const htmlDir = join(outputDir, 'html');
  const videoDir = join(outputDir, 'video');

  await mkdir(audioDir, { recursive: true });
  await mkdir(avatarDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });
  await mkdir(videoDir, { recursive: true });

  // 1. Parse storyboard
  console.log('═══════════════════════════════════════════════');
  console.log('  PIPELINE ORCHESTRATOR');
  console.log('═══════════════════════════════════════════════\n');

  const storyboard = await parseStoryboard(resolve(storyboardPath));
  console.log(`Storyboard: ${storyboard.mlTitle}`);
  console.log(`Domain: ${storyboard.domainKey} | Language: ${storyboard.language}`);
  console.log(`Total scenes: ${storyboard.numberOfScenes}`);
  console.log(`Concurrency: ${concurrency} parallel scenes\n`);

  // Expand slideshow scenes into individual slides
  let scenes = expandSlideshowScenes(storyboard.scenes);

  if (sceneFilter) {
    scenes = scenes.filter(s => s.sceneId.includes(sceneFilter));
    console.log(`Filtered to ${scenes.length} scene(s) matching "${sceneFilter}"\n`);
  }

  if (scenes.length !== storyboard.scenes.length) {
    console.log(`Scenes after slideshow expansion: ${scenes.length} (was ${storyboard.scenes.length})\n`);
  }

  if (scenes.length === 0) {
    console.log('No scenes to process.');
    return { scenes: [], recordings: [], finalVideo: null };
  }

  // 2. Process scenes or skip to stitch
  let results = [];
  let successfulRecordings = [];

  if (stitchOnly) {
    // Stitch-only mode: find existing MP4s in video dir
    console.log(`── Stitch-only mode: finding existing scene videos ──\n`);
    const { readdir } = await import('fs/promises');
    const existingFiles = await readdir(videoDir);
    const sceneMp4s = scenes
      .map(s => {
        const filename = `${s.sceneId}.mp4`;
        if (existingFiles.includes(filename)) {
          const videoPath = join(videoDir, filename);
          console.log(`  Found: ${filename}`);
          return { sceneId: s.sceneId, videoPath, recordSuccess: true };
        }
        console.log(`  Missing: ${filename}`);
        return null;
      })
      .filter(Boolean);

    successfulRecordings = sceneMp4s;
    results = sceneMp4s;
    console.log(`\n  ${sceneMp4s.length}/${scenes.length} scene videos found\n`);
  } else {
    // Normal mode: process all scenes
    console.log(`── Processing ${scenes.length} scenes ─────────────────────\n`);

    const ctx = { audioDir, avatarDir, htmlDir, videoDir, skipTTS, skipAvatar, skipRecord, fps, themeOverride };

    const tasks = scenes.map((scene, idx) => () => processScene(scene, idx, scenes, storyboard, ctx));
    results = await runWithConcurrency(tasks, concurrency);
    successfulRecordings = results.filter(r => r.recordSuccess && r.videoPath);
  }

  // 3. Stitch all scene videos into final MP4 (must be sequential — needs all scenes done)
  let finalVideoResult = null;

  if (!skipStitch && successfulRecordings.length > 0) {
    console.log('\n── Stitching final video (FFmpeg) ──────────────\n');

    const finalPath = join(outputDir, `${storyboard.mlId || 'final'}_video.mp4`);
    finalVideoResult = await stitchScenes({
      inputPaths: successfulRecordings.map(r => r.videoPath),
      outputPath: finalPath,
      gapMs,
    });

    if (finalVideoResult.success) {
      console.log(`  ✓ Final video: ${finalVideoResult.outputPath}`);
      console.log(`    Duration: ${finalVideoResult.durationSeconds}s | Size: ${finalVideoResult.fileSizeMB}MB`);
    } else {
      console.error(`  ✗ Stitching failed: ${finalVideoResult.error}`);
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════');
  console.log('  PIPELINE COMPLETE');
  console.log('═══════════════════════════════════════════════\n');
  console.log(`Scenes processed: ${results.length}`);
  if (successfulRecordings.length > 0) {
    console.log(`Scenes recorded:  ${successfulRecordings.length}/${results.length}`);
  }
  if (finalVideoResult?.success) {
    console.log(`Final video:      ${finalVideoResult.outputPath}`);
  }
  console.log('');

  return {
    scenes: results,
    recordings: successfulRecordings,
    finalVideo: finalVideoResult,
  };
}
